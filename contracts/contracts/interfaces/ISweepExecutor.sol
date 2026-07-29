// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Destination} from "./ISweepPolicy.sol";

/// @title ISweepExecutor — Interface for the BagSweep Sweep Executor
/// @notice Executes token swaps and routes proceeds to the chosen destination.

struct SwapParams {
    address tokenIn;        // meme token to sell
    uint256 amountIn;       // amount to sell
    uint256 spotQuote;      // keeper's expected USDG out at current spot. The
                            // enforced floor is derived from the USER's policy:
                            // spotQuote * (10000 - policy.maxSlippageBps) / 10000.
                            // (RH has no independent oracle, so spotQuote is keeper-
                            // declared and logged; the pct cap is the primary bound.)
    address router;         // DEX router address
    bytes swapData;         // pre-encoded swap calldata
}

interface ISweepExecutor {
    event SweepExecuted(
        address indexed account,
        address indexed tokenIn,
        uint256 amountIn,
        uint256 amountOut,
        Destination dest,
        uint256 timestamp
    );

    event SweepFailed(
        address indexed account,
        address indexed tokenIn,
        uint256 amountIn,
        string reason,
        uint256 timestamp
    );

    error SweepTooManyTokens();
    error SweepAmountMismatch();
    error SweepSlippageExceeded();
    error SweepNotFromAccount();

    /// @notice Execute a sweep: sell meme tokens via DEX, route proceeds to destination.
    /// @param swaps Array of swap parameters (one per meme token; no token may repeat).
    /// @param dest Where to route the proceeds.
    /// @param stockTarget Address of the target stock token (ignored if dest == USDG_YIELD).
    /// @param stockSpotQuote Keeper's expected stock output for the USDG->stock leg.
    ///        Required for STOCKS / SPLIT_50_50 (ignored for USDG_YIELD); the enforced
    ///        floor is stockSpotQuote * (10000 - policy.maxSlippageBps) / 10000.
    function executeSweep(
        SwapParams[] calldata swaps,
        Destination dest,
        address stockTarget,
        uint256 stockSpotQuote
    ) external;
}
