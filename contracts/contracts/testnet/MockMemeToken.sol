// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockMemeToken
 * @notice Mock meme token for testnet sweep-flow testing.
 */
contract MockMemeToken is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    /// @notice Mint tokens to any address (testnet faucet)
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
