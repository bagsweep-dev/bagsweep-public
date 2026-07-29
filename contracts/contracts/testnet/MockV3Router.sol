// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title MockV3Router
/// @notice Minimal Uniswap-V3-style SwapRouter for tests. Decodes the first/last
///         token from the packed V3 path, pulls the input from the caller, and pays
///         the output token to `recipient` at a fixed rate. Must be pre-funded with
///         the output token. Test only.
contract MockV3Router {
    using SafeERC20 for IERC20;

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

    // Matches SwapRouter02 (no `deadline` field), the variant deployed on RH mainnet.
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut) {
        bytes calldata path = params.path;
        address tokenIn = address(bytes20(path[0:20]));
        address tokenOut = address(bytes20(path[path.length - 20:path.length]));

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), params.amountIn);
        amountOut = (params.amountIn * rateNum) / rateDen;
        require(amountOut >= params.amountOutMinimum, "MockV3Router: slippage");
        IERC20(tokenOut).safeTransfer(params.recipient, amountOut);
    }
}
