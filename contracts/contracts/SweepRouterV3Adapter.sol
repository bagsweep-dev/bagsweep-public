// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @dev Minimal Uniswap V3 SwapRouter02 `exactInput` interface. Verified on-chain
///      2026-07-29 that RH mainnet's canonical periphery router is SwapRouter02 at
///      0xCaf681a66D020601342297493863E78C959E5cb2 (factory() == the RH V3 factory,
///      WETH9() == aeWETH, exactInput selector 0xb858183f). SwapRouter02's
///      ExactInputParams has NO `deadline` field; deadline is enforced by this adapter
///      directly (see swapExactTokensForTokens), not by the router.
interface IV3SwapRouter {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }
    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

/// @title SweepRouterV3Adapter
/// @author BagSweep
/// @notice Presents the Uniswap-V2 `swapExactTokensForTokens` interface that the
///         (frozen) SweepExecutor's self-routed-swap check requires, and internally
///         routes through RH's Uniswap V3 SwapRouter (`exactInput`) along the given
///         token path. This lets the V2-shaped executor use RH's V3 liquidity
///         WITHOUT modifying the audited executor: sanction this adapter as a router
///         on the executor, and the keeper builds multi-hop V2 paths to it.
/// @dev    Non-custodial: it pulls `path[0]` from the caller (the executor), swaps,
///         and sends the output to `to`; it holds no funds between calls. The V2
///         `path[]` carries no V3 fee tiers, so the owner configures the fee per
///         pool via {setPoolFee}; a hop with no configured fee reverts (no silent
///         wrong-pool routing). Slippage is still enforced: `amountOutMin` (the
///         executor's user-authored floor) is passed straight to the V3 router.
contract SweepRouterV3Adapter is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @dev RH Uniswap V3 SwapRouter.
    IV3SwapRouter public immutable v3Router;

    /// @dev Fee tier per unordered token pair: keccak(sorted(a,b)) => fee (uint24).
    mapping(bytes32 => uint24) public poolFee;

    error PathTooShort();
    error FeeNotSet(address a, address b);
    error DeadlinePassed();
    error ZeroAddress();

    event PoolFeeSet(address indexed tokenA, address indexed tokenB, uint24 fee);
    event TokensRescued(address indexed token, uint256 amount, address indexed dest);

    constructor(address _v3Router, address initialOwner) Ownable(initialOwner) {
        if (_v3Router == address(0)) revert ZeroAddress();
        v3Router = IV3SwapRouter(_v3Router);
    }

    /// @notice V2-compatible entrypoint the SweepExecutor calls. Routes
    ///         path[0] -> ... -> path[last] through the V3 router and sends the
    ///         output to `to`. `amountOutMin` is the executor's slippage floor.
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external nonReentrant returns (uint256[] memory amounts) {
        if (path.length < 2) revert PathTooShort();
        if (block.timestamp > deadline) revert DeadlinePassed();

        // Pull the input token from the caller (the executor approved us for it).
        IERC20(path[0]).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(path[0]).forceApprove(address(v3Router), amountIn);

        // SwapRouter02's exactInput carries no deadline; this adapter already enforced
        // `deadline` above (DeadlinePassed revert), so the check is not lost.
        uint256 out = v3Router.exactInput(
            IV3SwapRouter.ExactInputParams({
                path: _encodePath(path),
                recipient: to,
                amountIn: amountIn,
                amountOutMinimum: amountOutMin
            })
        );

        IERC20(path[0]).forceApprove(address(v3Router), 0);

        // V2-style return so the caller can read amounts[0]/amounts[last].
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        amounts[path.length - 1] = out;
    }

    /// @dev Encode the Uniswap V3 path: token0 ++ fee0 ++ token1 ++ fee1 ++ ... ++ tokenN.
    function _encodePath(address[] calldata path) internal view returns (bytes memory v3Path) {
        v3Path = abi.encodePacked(path[0]);
        for (uint256 i = 0; i < path.length - 1; i++) {
            uint24 fee = poolFee[_key(path[i], path[i + 1])];
            if (fee == 0) revert FeeNotSet(path[i], path[i + 1]);
            v3Path = abi.encodePacked(v3Path, fee, path[i + 1]);
        }
    }

    function _key(address a, address b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    /// @notice The configured V3 fee tier for a pool (0 if unset). Lets the keeper
    ///         read fees for route selection without replicating the pair key.
    function feeFor(address a, address b) external view returns (uint24) {
        return poolFee[_key(a, b)];
    }

    // ─────────────────────────── Admin ───────────────────────────────

    /// @notice Set the V3 fee tier for a pool (applies to both directions).
    /// @dev    Governance-sensitive: route through the timelock before mainnet.
    function setPoolFee(address tokenA, address tokenB, uint24 fee) external onlyOwner {
        poolFee[_key(tokenA, tokenB)] = fee;
        emit PoolFeeSet(tokenA, tokenB, fee);
    }

    /// @notice Rescue a stray token (the adapter holds no funds between calls).
    function rescue(address token, uint256 amount, address dest) external onlyOwner {
        IERC20(token).safeTransfer(dest, amount);
        emit TokensRescued(token, amount, dest);
    }
}
