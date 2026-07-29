// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockUSDG
 * @notice Mock USDG stablecoin for testnet deployment.
 *         Mintable by anyone — testnet only.
 */
contract MockUSDG is ERC20 {
    uint8 private constant _dec = 6; // USDG uses 6 decimals

    constructor() ERC20("USDG", "USDG") {}

    function decimals() public pure override returns (uint8) {
        return _dec;
    }

    /// @notice Mint tokens to any address (testnet faucet)
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
