// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title MockSwapRouter
/// @notice Minimal Uniswap-V2-style router for tests. Pulls path[0] from the
///         caller and sends path[last] to `to` at a fixed rate. Must be pre-funded
///         with the output token. Testnet/test only.
contract MockSwapRouter {
    using SafeERC20 for IERC20;

    /// @dev out = amountIn * rateNum / rateDen (test sets this to bridge decimals)
    uint256 public rateNum;
    uint256 public rateDen;

    constructor(uint256 _num, uint256 _den) {
        rateNum = _num;
        rateDen = _den;
    }

    function setRate(uint256 _num, uint256 _den) external {
        rateNum = _num;
        rateDen = _den;
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 /* deadline */
    ) external returns (uint256[] memory amounts) {
        IERC20(path[0]).safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 out = (amountIn * rateNum) / rateDen;
        require(out >= amountOutMin, "MockSwapRouter: slippage");
        IERC20(path[path.length - 1]).safeTransfer(to, out);

        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = out;
    }
}
