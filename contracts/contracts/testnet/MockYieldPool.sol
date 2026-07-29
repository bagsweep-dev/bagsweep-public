// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title MockYieldPool
/// @notice Minimal deposit(uint256,address) pool for tests. When `misbehave` is set
///         it returns success WITHOUT pulling the asset, to exercise the executor's
///         deposit-consumed check and its fallback transfer. Test only.
contract MockYieldPool {
    using SafeERC20 for IERC20;

    address public immutable asset;
    bool public misbehave;
    mapping(address => uint256) public shares;

    constructor(address _asset) {
        asset = _asset;
    }

    function setMisbehave(bool b) external {
        misbehave = b;
    }

    function deposit(uint256 amount, address to) external {
        if (misbehave) return; // returns success but pulls nothing
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        shares[to] += amount;
    }
}
