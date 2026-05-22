// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "../mocks/MockERC20.sol";

// Simulates Aave V3 Pool for testing:
//   - supply(): transfers USDT in, mints equal aUSDT to recipient
//   - withdraw(): burns aUSDT, transfers USDT back to recipient
//   - addYield(): test helper — mints extra aUSDT to simulate accrued interest
contract MockAavePool {
    MockERC20 public usdt;
    MockERC20 public aUsdt;

    constructor(address _usdt, address _aUsdt) {
        usdt  = MockERC20(_usdt);
        aUsdt = MockERC20(_aUsdt);
    }

    // Called by Zorrito: deposit USDT → get aUSDT 1:1
    function supply(
        address asset,
        uint256 amount,
        address onBehalfOf,
        uint16  /*referralCode*/
    ) external {
        require(asset == address(usdt), "wrong asset");
        usdt.transferFrom(msg.sender, address(this), amount);
        aUsdt.mint(onBehalfOf, amount);
    }

    // Called by Zorrito: burn aUSDT → get USDT back
    function withdraw(
        address asset,
        uint256 amount,
        address to
    ) external returns (uint256) {
        require(asset == address(usdt), "wrong asset");
        aUsdt.burn(msg.sender, amount);
        usdt.transfer(to, amount);
        return amount;
    }

    // Test helper: simulate interest accruing
    // Mints extra aUSDT to the Zorrito contract without backing USDT
    function addYield(address zorrito, uint256 yieldAmount) external {
        aUsdt.mint(zorrito, yieldAmount);
    }
}
