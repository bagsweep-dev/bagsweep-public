// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title ISweepPolicy — Interface for the BagSweep Policy Registry
/// @notice Defines the data structures and events for managing sweep policies.

// Sweep sizing intent. NOTE: `mode` is NOT enforced on-chain. The executor always
// caps at `pct` of the CURRENT balance (RH has no cost basis to compute profits),
// so PROFITS is honored only by the off-chain keeper; on-chain, the pct cap is the
// bound for BOTH modes.
enum SweepMode {
    POSITION,   // sweep a percentage of the entire position
    PROFITS     // sweep only unrealized profits (keeper-enforced; see note above)
}

enum Destination {
    USDG_YIELD,     // sweep to USDG lending pool
    STOCKS,         // sweep to tokenized equities
    SPLIT_50_50     // 50% USDG yield, 50% stocks
}

struct SweepPolicy {
    uint16 pct;                     // basis points: 500 = 5%, 2500 = 25%
    uint16 maxSlippageBps;          // user-authored slippage tolerance: the sweep's
                                    // USDG output floor is quote * (10000 - this) / 10000
    uint128 minUsd;                 // minimum position value (6dp USDG). KEEPER HINT
                                    // only: NOT enforced on-chain (RH has no cost
                                    // basis), so a keeper may sweep below this.
    SweepMode mode;                 // POSITION or PROFITS
    Destination dest;               // USDG_YIELD, STOCKS, SPLIT_50_50
    address[] tokenWhitelist;       // restrict sweep to these tokens (empty = all)
    bool active;                    // on/off switch
    uint256 createdAt;
    uint256 updatedAt;
}

interface ISweepPolicy {
    event PolicySet(
        address indexed account,
        uint16 pct,
        SweepMode mode,
        Destination dest,
        uint256 timestamp
    );

    event PolicyRevoked(address indexed account, uint256 timestamp);

    error PolicyNotFound(address account);
    error PolicyAlreadyExists(address account);
    error InvalidPercentage();
    error InvalidSlippage();
    error WhitelistTooLong();
    error Paused();

    function setPolicy(
        uint16 pct,
        uint128 minUsd,
        SweepMode mode,
        Destination dest,
        address[] calldata tokenWhitelist,
        uint16 maxSlippageBps
    ) external;

    function revokePolicy() external;

    function getPolicy(address account) external view returns (SweepPolicy memory);

    function policyCount() external view returns (uint256);

    function getActiveAccounts() external view returns (address[] memory);
}
