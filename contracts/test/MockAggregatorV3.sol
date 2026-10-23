// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MockAggregatorV3
/// @notice Mock implementation of Chainlink AggregatorV3Interface for testing
contract MockAggregatorV3 {
    uint8 private _decimals;
    int256 private _answer;
    uint256 private _updatedAt;
    uint80 private _roundId;
    uint80 private _answeredInRound;

    constructor(uint8 decimals_) {
        _decimals = decimals_;
        _answer = int256(100 * (10 ** decimals_));
        _updatedAt = block.timestamp;
        _roundId = 1;
        _answeredInRound = 1; // Round complete by default
    }

    function setLatestAnswer(int256 answer_) external {
        _answer = answer_;
        _updatedAt = block.timestamp;
    }

    function setLastUpdated(uint256 timestamp) external {
        _updatedAt = timestamp;
    }

    function setRoundIncomplete() external {
        _answeredInRound = 0; // Not equal to roundId
    }

    function setRoundComplete() external {
        _answeredInRound = _roundId;
    }

    function decimals() external view returns (uint8) {
        return _decimals;
    }

    function latestRoundData()
        external
        view
        returns (
            uint80,
            int256,
            uint256,
            uint256,
            uint80
        )
    {
        return (_roundId, _answer, _updatedAt, _updatedAt, _answeredInRound);
    }

    function getAnswer() external view returns (int256) {
        return _answer;
    }

    function getUpdatedAt() external view returns (uint256) {
        return _updatedAt;
    }
}