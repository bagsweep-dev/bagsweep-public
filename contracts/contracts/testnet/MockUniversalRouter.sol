// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockPermit2} from "./MockPermit2.sol";

/// @title MockUniversalRouter
/// @notice Minimal Uniswap-V4 UniversalRouter for tests. Decodes the adapter's plan
///         enough to read the SETTLE_ALL (tokenIn, amountIn) and TAKE_ALL (tokenOut,
///         minOut) params, pulls the input from the caller via Permit2, and pays the
///         output to `msg.sender` (the caller) at a per-direction fixed rate — exactly
///         how V4 TAKE_ALL delivers (to the router's caller, i.e. the adapter). Must be
///         pre-funded with the output token. Test only.
contract MockUniversalRouter {
    MockPermit2 public immutable permit2;
    mapping(bytes32 => uint256) public rateNum; // out = in * num/den, keyed by (tokenIn,tokenOut)
    mapping(bytes32 => uint256) public rateDen;

    constructor(address _permit2) {
        permit2 = MockPermit2(_permit2);
    }

    function _k(address a, address b) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(a, b));
    }

    function setRate(address tokenIn, address tokenOut, uint256 num, uint256 den) external {
        rateNum[_k(tokenIn, tokenOut)] = num;
        rateDen[_k(tokenIn, tokenOut)] = den;
    }

    function execute(bytes calldata /*commands*/, bytes[] calldata inputs, uint256 deadline) external payable {
        require(block.timestamp <= deadline, "MockUR: deadline");
        (, bytes[] memory params) = abi.decode(inputs[0], (bytes, bytes[]));
        // Currency is `type Currency is address`, ABI-encoded as address.
        (address tokenIn, uint256 amountIn) = abi.decode(params[1], (address, uint256));   // SETTLE_ALL
        (address tokenOut, uint256 minOut) = abi.decode(params[2], (address, uint256));     // TAKE_ALL

        // Pull input from the caller (the adapter) via Permit2, then pay output to it.
        permit2.transferFrom(msg.sender, address(this), uint160(amountIn), tokenIn);
        uint256 den = rateDen[_k(tokenIn, tokenOut)];
        require(den > 0, "MockUR: no rate");
        uint256 out = (amountIn * rateNum[_k(tokenIn, tokenOut)]) / den;
        require(out >= minOut, "MockUR: too little received"); // TAKE_ALL floor
        require(IERC20(tokenOut).transfer(msg.sender, out), "MockUR: pay"); // TAKE_ALL -> caller
    }
}
