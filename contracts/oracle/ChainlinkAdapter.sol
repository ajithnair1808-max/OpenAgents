// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ChainlinkAdapter
/// @notice Adapter for Chainlink price feeds with normalized 18-decimal output and multi-hop price derivation
/// @dev Supports direct price feeds and derived prices via intermediate tokens (base/quote -> intermediate -> quote)
contract ChainlinkAdapter {
    address public admin;
    uint256 public constant TARGET_DECIMALS = 18;

    /// @notice Configuration for a single price feed
    /// @param feed The Chainlink aggregator address
    /// @param heartbeat Maximum seconds between updates before feed is considered stale
    /// @param active Whether the feed is currently active
    /// @param feedDecimals Cached decimals for the feed to avoid external calls
    struct FeedConfig {
        AggregatorV3Interface feed;
        uint256 heartbeat;
        bool active;
        uint8 feedDecimals;
    }

    /// @notice Configuration for a derived (multi-hop) price
    /// @param intermediateToken The intermediate token address used for price derivation
    /// @param active Whether the derived price is active
    struct DerivedPriceConfig {
        address intermediateToken;
        bool active;
    }

    mapping(address => FeedConfig) public feeds;
    mapping(address => DerivedPriceConfig) public derivedPrices;

    /// @dev Emitted when a new price feed is registered
    event FeedRegistered(address indexed token, address feed, uint256 heartbeat);
    /// @dev Emitted when a price feed is deactivated
    event FeedDeactivated(address indexed token);
    /// @dev Emitted when a derived price configuration is registered
    event DerivedPriceRegistered(address indexed baseToken, address intermediateToken);
    /// @dev Emitted when a derived price configuration is deactivated
    event DerivedPriceDeactivated(address indexed baseToken);
    /// @dev Emitted when a stale price is detected
    event PriceStale(address indexed token, uint256 lastUpdate, uint256 heartbeat);

    modifier onlyAdmin() {
        require(msg.sender == admin, "Not admin");
        _;
    }

    constructor() {
        admin = msg.sender;
    }

    /// @notice Register a new Chainlink price feed for a token
    /// @param token The token address to associate with this feed
    /// @param feed The Chainlink aggregator address
    /// @param heartbeat Maximum seconds between updates before feed is considered stale
    function registerFeed(
        address token,
        address feed,
        uint256 heartbeat
    ) external onlyAdmin {
        require(feed != address(0), "Invalid feed");
        require(heartbeat > 0, "Invalid heartbeat");

        uint8 feedDecimals = AggregatorV3Interface(feed).decimals();

        feeds[token] = FeedConfig({
            feed: AggregatorV3Interface(feed),
            heartbeat: heartbeat,
            active: true,
            feedDecimals: feedDecimals
        });

        emit FeedRegistered(token, feed, heartbeat);
    }

    /// @notice Deactivate a price feed for a token
    /// @param token The token address whose feed should be deactivated
    function deactivateFeed(address token) external onlyAdmin {
        feeds[token].active = false;
        emit FeedDeactivated(token);
    }

    /// @notice Register a derived price configuration for multi-hop price queries
    /// @param baseToken The base token to derive price for
    /// @param intermediateToken The intermediate token for price derivation
    /// @dev Requires both baseToken/intermediateToken and intermediateToken/quote feeds to be registered
    function registerDerivedPrice(address baseToken, address intermediateToken) external onlyAdmin {
        require(feeds[baseToken].active, "Base feed not active");
        require(feeds[intermediateToken].active, "Intermediate feed not active");

        derivedPrices[baseToken] = DerivedPriceConfig({
            intermediateToken: intermediateToken,
            active: true
        });

        emit DerivedPriceRegistered(baseToken, intermediateToken);
    }

    /// @notice Deactivate a derived price configuration
    /// @param baseToken The base token whose derived price config should be deactivated
    function deactivateDerivedPrice(address baseToken) external onlyAdmin {
        derivedPrices[baseToken].active = false;
        emit DerivedPriceDeactivated(baseToken);
    }

    /// @notice Get the price of a token, either directly or via multi-hop derivation
    /// @param token The token address to get price for
    /// @return price Normalized price with 18 decimals
    /// @dev For derived prices, returns base/quote price using intermediate token as bridge
    function getPrice(address token) external view returns (uint256) {
        FeedConfig storage config = feeds[token];
        require(config.active, "Feed not active");

        (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound) = config.feed.latestRoundData();

        // Validate round completeness - answeredInRound must equal roundId
        require(answeredInRound == roundId, "Round incomplete");
        
        // Validate staleness against heartbeat
        require(block.timestamp - updatedAt <= config.heartbeat, "Price stale");

        // Validate non-negative price
        require(answer > 0, "Negative price");

        uint256 price = uint256(answer);

        // Normalize to 18 decimals
        if (config.feedDecimals < TARGET_DECIMALS) {
            price = price * (10 ** (TARGET_DECIMALS - config.feedDecimals));
        } else if (config.feedDecimals > TARGET_DECIMALS) {
            price = price / (10 ** (config.feedDecimals - TARGET_DECIMALS));
        }

        return price;
    }

    /// @notice Get derived price via multi-hop (base -> intermediate -> quote)
    /// @param baseToken The base token to derive price for
    /// @param intermediateToken The intermediate token to use as bridge
    /// @param quoteToken The quote token for final price calculation
    /// @return price Normalized derived price with 18 decimals
    /// @dev Returns base/quote price by combining base/intermediate and intermediate/quote feeds.
    /// Staleness is checked on both feeds; reverts if either feed is stale.
    /// Decimal normalization is applied independently to each feed before combining.
    /// basePrice feed returns: amount of intermediate tokens per base token
    /// intermediatePrice feed returns: amount of quote tokens per intermediate token
    /// derivedPrice = basePrice * intermediatePrice (to get quote per base)
    function derivedPrice(
        address baseToken,
        address intermediateToken,
        address quoteToken
    ) external view returns (uint256 price) {
        FeedConfig storage baseConfig = feeds[baseToken];
        FeedConfig storage intermediatePriceConfig = feeds[intermediateToken];
        FeedConfig storage quoteConfig = feeds[quoteToken];

        require(baseConfig.active, "Base feed not active");
        require(intermediatePriceConfig.active, "Intermediate feed not active");
        require(quoteConfig.active, "Quote feed not active");

        // Fetch base/intermediate price data (price of base token in intermediate units)
        // This is the price feed registered for baseToken
        (uint80 baseRoundId, int256 baseAnswer, uint256 baseStartedAt, uint256 baseUpdatedAt, uint80 baseAnsweredInRound) = baseConfig.feed.latestRoundData();

        // Fetch intermediate/quote price data (price of intermediate token in quote units)
        // This is the price feed registered for intermediateToken
        (uint80 intermediateRoundId, int256 intermediateAnswer, uint256 intermediateStartedAt, uint256 intermediateUpdatedAt, uint80 intermediateAnsweredInRound) = intermediatePriceConfig.feed.latestRoundData();

        // Validate round completeness for both feeds
        require(baseAnsweredInRound == baseRoundId, "Base round incomplete");
        require(intermediateAnsweredInRound == intermediateRoundId, "Quote round incomplete");

        // Validate staleness for both feeds using their respective heartbeats
        require(block.timestamp - baseUpdatedAt <= baseConfig.heartbeat, "Base price stale");
        require(block.timestamp - intermediateUpdatedAt <= intermediatePriceConfig.heartbeat, "Quote price stale");

        // Validate non-negative prices
        require(baseAnswer > 0, "Negative base price");
        require(intermediateAnswer > 0, "Negative quote price");

        // Convert to uint256 after validation
        uint256 basePrice = uint256(baseAnswer);
        uint256 intermediatePrice = uint256(intermediateAnswer);

        // Normalize both prices to 18 decimals
        // basePrice: price of base token in intermediate units, normalized
        if (baseConfig.feedDecimals < TARGET_DECIMALS) {
            basePrice = basePrice * (10 ** (TARGET_DECIMALS - baseConfig.feedDecimals));
        } else if (baseConfig.feedDecimals > TARGET_DECIMALS) {
            basePrice = basePrice / (10 ** (baseConfig.feedDecimals - TARGET_DECIMALS));
        }

        // intermediatePrice: price of intermediate token in quote units, normalized
        if (intermediatePriceConfig.feedDecimals < TARGET_DECIMALS) {
            intermediatePrice = intermediatePrice * (10 ** (TARGET_DECIMALS - intermediatePriceConfig.feedDecimals));
        } else if (intermediatePriceConfig.feedDecimals > TARGET_DECIMALS) {
            intermediatePrice = intermediatePrice / (10 ** (intermediatePriceConfig.feedDecimals - TARGET_DECIMALS));
        }

        // Derived price = basePrice * intermediatePrice
        // This gives us quote units per base token
        price = (basePrice * intermediatePrice) / (10 ** TARGET_DECIMALS);
    }

    /// @notice Get feed information for a token
    /// @param token The token address to query
    /// @return feedAddress The Chainlink aggregator address
    /// @return heartbeat The configured heartbeat in seconds
    /// @return active Whether the feed is active
    /// @return feedDecimals The decimals of the feed
    function getFeedInfo(address token) external view returns (
        address feedAddress,
        uint256 heartbeat,
        bool active,
        uint8 feedDecimals
    ) {
        FeedConfig storage config = feeds[token];
        return (address(config.feed), config.heartbeat, config.active, config.feedDecimals);
    }

    /// @notice Get derived price configuration for a token
    /// @param token The base token address to query
    /// @return intermediateToken The intermediate token address
    /// @return active Whether the derived price is active
    function getDerivedPriceInfo(address token) external view returns (
        address intermediateToken,
        bool active
    ) {
        DerivedPriceConfig storage config = derivedPrices[token];
        return (config.intermediateToken, config.active);
    }

    /// @notice Check if a price feed is stale
    /// @param token The token address to check
    /// @return stale Whether the feed is stale
    /// @return lastUpdate Timestamp of last update
    /// @dev Does not revert; returns boolean status
    function isStale(address token) external view returns (bool stale, uint256 lastUpdate) {
        FeedConfig storage config = feeds[token];
        
        if (!config.active) {
            return (true, 0);
        }

        (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound) = config.feed.latestRoundData();

        lastUpdate = updatedAt;
        stale = (block.timestamp - updatedAt) > config.heartbeat;
    }
}

/// @notice Interface for Chainlink AggregatorV3
interface AggregatorV3Interface {
    function latestRoundData() external view returns (
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    );
    function decimals() external view returns (uint8);
}