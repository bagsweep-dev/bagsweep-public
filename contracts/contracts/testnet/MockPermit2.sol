// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title MockPermit2
/// @notice Minimal Permit2 for tests: records approve() allowances and pulls tokens
///         via the owner's ERC-20 approval to this contract. Test only — models the
///         two-step allowance the V4 adapter relies on (ERC20 -> Permit2, Permit2 ->
///         router). Not the real Permit2 (no signatures, nonces, or expiry checks).
contract MockPermit2 {
    // owner => token => spender => amount
    mapping(address => mapping(address => mapping(address => uint160))) public allowance;

    function approve(address token, address spender, uint160 amount, uint48 /*expiration*/) external {
        allowance[msg.sender][token][spender] = amount;
    }

    /// @dev Pull `amount` of `token` from `from` to `to`. Caller (msg.sender) is the
    ///      spender; it must have a Permit2 allowance, and `from` must have approved
    ///      this contract as an ERC-20 spender (the adapter's forceApprove(permit2)).
    function transferFrom(address from, address to, uint160 amount, address token) external {
        uint160 a = allowance[from][token][msg.sender];
        require(a >= amount, "MockPermit2: allowance");
        allowance[from][token][msg.sender] = a - amount;
        require(IERC20(token).transferFrom(from, to, amount), "MockPermit2: transfer");
    }
}
