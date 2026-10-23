const { expect } = require("chai");
const { ethers } = require("hardhat");

// Helper to create deterministic addresses from strings
function addressFrom(string) {
    return "0x" + ethers.keccak256(ethers.toUtf8Bytes(string)).slice(2, 42).toLowerCase();
}

describe("ChainlinkAdapter", function () {
  let chainlinkAdapter;
  let owner, admin, user;
  let mockAggregator1, mockAggregator2, mockAggregator3;
  let mockAggregatorWBTC, mockAggregatorWETH, mockAggregatorUSDC;

  const FEED_DECIMALS_8 = 8;
  const FEED_DECIMALS_18 = 18;
  const FEED_DECIMALS_6 = 6;
  const HEARTBEAT = 3600; // 1 hour

  before(async function () {
    [owner, admin, user] = await ethers.getSigners();
  });

  beforeEach(async function () {
    // Deploy mock aggregators
    const MockAggregator = await ethers.getContractFactory("MockAggregatorV3");
    mockAggregator1 = await MockAggregator.deploy(FEED_DECIMALS_8);
    mockAggregator2 = await MockAggregator.deploy(FEED_DECIMALS_18);
    mockAggregator3 = await MockAggregator.deploy(FEED_DECIMALS_8);
    mockAggregatorWBTC = await MockAggregator.deploy(FEED_DECIMALS_8);
    mockAggregatorWETH = await MockAggregator.deploy(FEED_DECIMALS_18);
    mockAggregatorUSDC = await MockAggregator.deploy(FEED_DECIMALS_6); // USDC has 6 decimals

    // Deploy ChainlinkAdapter
    const ChainlinkAdapter = await ethers.getContractFactory("ChainlinkAdapter");
    chainlinkAdapter = await ChainlinkAdapter.deploy();
  });

  describe("Feed Registration", function () {
    it("should register a feed with correct parameters", async function () {
      const token = addressFrom("TOKEN1");
      await chainlinkAdapter.registerFeed(
        token,
        mockAggregator1.target,
        HEARTBEAT
      );

      const feedInfo = await chainlinkAdapter.getFeedInfo(token);
      expect(feedInfo.feedAddress.toLowerCase()).to.equal(mockAggregator1.target.toLowerCase());
      expect(feedInfo.heartbeat).to.equal(HEARTBEAT);
      expect(feedInfo.active).to.be.true;
      expect(feedInfo.feedDecimals).to.equal(FEED_DECIMALS_8);
    });

    it("should reject zero address feed", async function () {
      const token = addressFrom("TOKEN1");
      await expect(
        chainlinkAdapter.registerFeed(
          token,
          ethers.ZeroAddress,
          HEARTBEAT
        )
      ).to.be.revertedWith("Invalid feed");
    });

    it("should reject zero heartbeat", async function () {
      const token = addressFrom("TOKEN1");
      await expect(
        chainlinkAdapter.registerFeed(
          token,
          mockAggregator1.target,
          0
        )
      ).to.be.revertedWith("Invalid heartbeat");
    });

    it("should only allow admin to register feeds", async function () {
      const token = addressFrom("TOKEN1");
      await expect(
        chainlinkAdapter.connect(user).registerFeed(
          token,
          mockAggregator1.target,
          HEARTBEAT
        )
      ).to.be.revertedWith("Not admin");
    });

    it("should deactivate a feed", async function () {
      const token = addressFrom("TOKEN1");
      await chainlinkAdapter.registerFeed(
        token,
        mockAggregator1.target,
        HEARTBEAT
      );

      await chainlinkAdapter.deactivateFeed(token);
      
      const feedInfo = await chainlinkAdapter.getFeedInfo(token);
      expect(feedInfo.active).to.be.false;
    });
  });

  describe("getPrice", function () {
    const TOKEN1 = addressFrom("TOKEN1");

    beforeEach(async function () {
      await chainlinkAdapter.registerFeed(TOKEN1, mockAggregator1.target, HEARTBEAT);
      // Set price to 100 with 8 decimals = 100 * 10^8
      await mockAggregator1.setLatestAnswer(ethers.parseUnits("100", FEED_DECIMALS_8));
    });

    it("should return normalized price with 18 decimals", async function () {
      const price = await chainlinkAdapter.getPrice(TOKEN1);
      // 100 * 10^8 normalized to 18 decimals = 100 * 10^10
      const expected = ethers.parseUnits("100", 18);
      expect(price).to.equal(expected);
    });

    it("should reject inactive feed", async function () {
      await chainlinkAdapter.deactivateFeed(TOKEN1);
      await expect(chainlinkAdapter.getPrice(TOKEN1)).to.be.revertedWith("Feed not active");
    });

    it("should reject price when round is incomplete", async function () {
      await mockAggregator1.setRoundIncomplete();
      await expect(chainlinkAdapter.getPrice(TOKEN1)).to.be.revertedWith("Round incomplete");
    });

    it("should reject stale price", async function () {
      // Set a very old timestamp
      const block = await ethers.provider.getBlock("latest");
      await mockAggregator1.setLastUpdated(BigInt(block.timestamp) - 2n * BigInt(HEARTBEAT));
      await expect(chainlinkAdapter.getPrice(TOKEN1)).to.be.revertedWith("Price stale");
    });

    it("should reject negative price", async function () {
      const negAmount = ethers.parseUnits("100", FEED_DECIMALS_8);
      const negInt = -BigInt(negAmount);
      await mockAggregator1.setLatestAnswer(negInt);
      await expect(chainlinkAdapter.getPrice(TOKEN1)).to.be.revertedWith("Negative price");
    });
  });

  describe("Derived Price (multi-hop)", function () {
    const BASE = addressFrom("BASE");
    const INTERMEDIATE = addressFrom("INTERMEDIATE");
    const QUOTE = addressFrom("QUOTE");
    const HEARTBEAT_SHORT = 3600;

    beforeEach(async function () {
      // Register feeds for multi-hop
      // BASE/INTERMEDIATE = 2000 (e.g., WBTC/ETH = 2000)
      await chainlinkAdapter.registerFeed(BASE, mockAggregatorWBTC.target, HEARTBEAT_SHORT);
      // INTERMEDIATE/QUOTE = 3000 (e.g., ETH/USDC = 3000)
      // Note: We use intermediateToken as the key for the intermediate/quote feed
      await chainlinkAdapter.registerFeed(INTERMEDIATE, mockAggregatorWETH.target, HEARTBEAT_SHORT);
      await chainlinkAdapter.registerFeed(QUOTE, mockAggregatorUSDC.target, HEARTBEAT_SHORT);

      // Set prices
      // WBTC/ETH = 2000 (8 decimals) - price of BASE in INTERMEDIATE units
      await mockAggregatorWBTC.setLatestAnswer(ethers.parseUnits("2000", FEED_DECIMALS_8));
      // ETH/USDC = 3000 (18 decimals) - price of INTERMEDIATE in QUOTE units
      await mockAggregatorWETH.setLatestAnswer(ethers.parseUnits("3000", FEED_DECIMALS_18));
      // USDC/USD = 1 (6 decimals) - this is the quote
      await mockAggregatorUSDC.setLatestAnswer(ethers.parseUnits("1", FEED_DECIMALS_6));
    });

    it("should calculate derived price correctly with decimal normalization", async function () {
      // derivedPrice = basePrice * intermediatePrice
      // = 2000 (WBTC/ETH) * 3000 (ETH/USDC) = 6,000,000 (WBTC/USDC)
      // Normalized: 6,000,000 * 10^18
      const derivedPrice = await chainlinkAdapter.derivedPrice(BASE, INTERMEDIATE, QUOTE);
      
      const expected = ethers.parseUnits("6000000", 18);
      expect(derivedPrice).to.equal(expected);
    });

    it("should reject when base feed is inactive", async function () {
      await chainlinkAdapter.deactivateFeed(BASE);
      await expect(chainlinkAdapter.derivedPrice(BASE, INTERMEDIATE, QUOTE))
        .to.be.revertedWith("Base feed not active");
    });

    it("should reject when intermediate feed is inactive", async function () {
      await chainlinkAdapter.deactivateFeed(INTERMEDIATE);
      await expect(chainlinkAdapter.derivedPrice(BASE, INTERMEDIATE, QUOTE))
        .to.be.revertedWith("Intermediate feed not active");
    });

    it("should reject when quote feed is inactive", async function () {
      await chainlinkAdapter.deactivateFeed(QUOTE);
      await expect(chainlinkAdapter.derivedPrice(BASE, INTERMEDIATE, QUOTE))
        .to.be.revertedWith("Quote feed not active");
    });

    it("should reject when base price is stale", async function () {
      const block = await ethers.provider.getBlock("latest");
      await mockAggregatorWBTC.setLastUpdated(BigInt(block.timestamp) - 2n * BigInt(HEARTBEAT_SHORT));
      await expect(chainlinkAdapter.derivedPrice(BASE, INTERMEDIATE, QUOTE))
        .to.be.revertedWith("Base price stale");
    });

    it("should reject when quote price is stale", async function () {
      const block = await ethers.provider.getBlock("latest");
      await mockAggregatorWETH.setLastUpdated(BigInt(block.timestamp) - 2n * BigInt(HEARTBEAT_SHORT));
      await expect(chainlinkAdapter.derivedPrice(BASE, INTERMEDIATE, QUOTE))
        .to.be.revertedWith("Quote price stale");
    });

    it("should reject when base round is incomplete", async function () {
      await mockAggregatorWBTC.setRoundIncomplete();
      await expect(chainlinkAdapter.derivedPrice(BASE, INTERMEDIATE, QUOTE))
        .to.be.revertedWith("Base round incomplete");
    });

    it("should reject when quote round is incomplete", async function () {
      await mockAggregatorWETH.setRoundIncomplete();
      await expect(chainlinkAdapter.derivedPrice(BASE, INTERMEDIATE, QUOTE))
        .to.be.revertedWith("Quote round incomplete");
    });

    it("should reject when base price is negative", async function () {
      const amount = ethers.parseUnits("100", FEED_DECIMALS_8);
      await mockAggregatorWBTC.setLatestAnswer(-BigInt(amount));
      await expect(chainlinkAdapter.derivedPrice(BASE, INTERMEDIATE, QUOTE))
        .to.be.revertedWith("Negative base price");
    });

    it("should reject when quote price is negative", async function () {
      const amount = ethers.parseUnits("1", FEED_DECIMALS_18);
      await mockAggregatorWETH.setLatestAnswer(-BigInt(amount));
      await expect(chainlinkAdapter.derivedPrice(BASE, INTERMEDIATE, QUOTE))
        .to.be.revertedWith("Negative quote price");
    });

    it("should reject when quote price is zero", async function () {
      await mockAggregatorWETH.setLatestAnswer(0);
      await expect(chainlinkAdapter.derivedPrice(BASE, INTERMEDIATE, QUOTE))
        .to.be.revertedWith("Negative quote price");
    });
  });

  describe("Decimal Normalization", function () {
    it("should handle 8-decimal feed normalization", async function () {
      const token = addressFrom("TOKEN_8DEC");
      await chainlinkAdapter.registerFeed(token, mockAggregator1.target, HEARTBEAT);
      await mockAggregator1.setLatestAnswer(ethers.parseUnits("100", FEED_DECIMALS_8));

      const price = await chainlinkAdapter.getPrice(token);
      // Should be normalized to 100 * 10^10
      const expected = ethers.parseUnits("100", 18);
      expect(price).to.equal(expected);
    });

    it("should handle 18-decimal feed normalization", async function () {
      const token = addressFrom("TOKEN_18DEC");
      await chainlinkAdapter.registerFeed(token, mockAggregator2.target, HEARTBEAT);
      await mockAggregator2.setLatestAnswer(ethers.parseUnits("100", FEED_DECIMALS_18));

      const price = await chainlinkAdapter.getPrice(token);
      // Should remain 100 * 10^18
      const expected = ethers.parseUnits("100", 18);
      expect(price).to.equal(expected);
    });

    it("should handle derived price with mixed decimal feeds", async function () {
      const token8 = addressFrom("TOKEN_8");
      const token18 = addressFrom("TOKEN_18");
      const quote = addressFrom("QUOTE_MIXED");

      await chainlinkAdapter.registerFeed(token8, mockAggregator1.target, HEARTBEAT);
      await chainlinkAdapter.registerFeed(token18, mockAggregator2.target, HEARTBEAT);
      await chainlinkAdapter.registerFeed(quote, mockAggregatorUSDC.target, HEARTBEAT);

      // 8-decimal feed: 1000 (price of token8 in token18 units)
      await mockAggregator1.setLatestAnswer(ethers.parseUnits("1000", FEED_DECIMALS_8));
      // 18-decimal feed: 2000 (price of token18 in quote units)
      await mockAggregator2.setLatestAnswer(ethers.parseUnits("2000", FEED_DECIMALS_18));
      // Quote: 1
      await mockAggregatorUSDC.setLatestAnswer(ethers.parseUnits("1", FEED_DECIMALS_6));

      const derivedPrice = await chainlinkAdapter.derivedPrice(token8, token18, quote);
      // derivedPrice = (1000 * 10^10) * (2000 * 10^18) / 10^18
      // = 1000 * 2000 = 2,000,000
      const expected = ethers.parseUnits("2000000", 18);
      expect(derivedPrice).to.equal(expected);
    });
  });

  describe("isStale", function () {
    const token = addressFrom("TOKEN1");

    beforeEach(async function () {
      await chainlinkAdapter.registerFeed(token, mockAggregator1.target, HEARTBEAT);
    });

    it("should return false for fresh price", async function () {
      const result = await chainlinkAdapter.isStale.staticCall(token);
      expect(result.stale).to.be.false;
      expect(result.lastUpdate).to.be.gt(0);
    });

    it("should return true for stale price", async function () {
      const block = await ethers.provider.getBlock("latest");
      await mockAggregator1.setLastUpdated(BigInt(block.timestamp) - 2n * BigInt(HEARTBEAT));
      const result = await chainlinkAdapter.isStale.staticCall(token);
      expect(result.stale).to.be.true;
    });

    it("should return true for inactive feed", async function () {
      await chainlinkAdapter.deactivateFeed(token);
      const result = await chainlinkAdapter.isStale.staticCall(token);
      expect(result.stale).to.be.true;
      expect(result.lastUpdate).to.equal(0);
    });
  });

  describe("Derived Price Registration", function () {
    const BASE = addressFrom("BASE_DERIVED");
    const INTERMEDIATE = addressFrom("INTERMEDIATE_DERIVED");

    beforeEach(async function () {
      await chainlinkAdapter.registerFeed(BASE, mockAggregator1.target, HEARTBEAT);
      await chainlinkAdapter.registerFeed(INTERMEDIATE, mockAggregator2.target, HEARTBEAT);
    });

    it("should register derived price with valid feeds", async function () {
      await chainlinkAdapter.registerDerivedPrice(BASE, INTERMEDIATE);
      
      const info = await chainlinkAdapter.getDerivedPriceInfo(BASE);
      expect(info.intermediateToken.toLowerCase()).to.equal(INTERMEDIATE.toLowerCase());
      expect(info.active).to.be.true;
    });

    it("should reject derived price if base feed not active", async function () {
      await chainlinkAdapter.deactivateFeed(BASE);
      await expect(chainlinkAdapter.registerDerivedPrice(BASE, INTERMEDIATE))
        .to.be.revertedWith("Base feed not active");
    });

    it("should reject derived price if intermediate feed not active", async function () {
      await chainlinkAdapter.deactivateFeed(INTERMEDIATE);
      await expect(chainlinkAdapter.registerDerivedPrice(BASE, INTERMEDIATE))
        .to.be.revertedWith("Intermediate feed not active");
    });

    it("should deactivate derived price", async function () {
      await chainlinkAdapter.registerDerivedPrice(BASE, INTERMEDIATE);
      await chainlinkAdapter.deactivateDerivedPrice(BASE);
      
      const info = await chainlinkAdapter.getDerivedPriceInfo(BASE);
      expect(info.active).to.be.false;
    });
  });
});