// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AgripinaaYieldRouter, IERC20} from "../src/AgripinaaYieldRouter.sol";

/**
 * Fork test against real BSC mainnet Venus + Aave. Proves the router rotates a
 * user's USDT between venues and back, holds nothing between calls, and can
 * never move value to anyone but the caller.
 *
 * Run: forge test --fork-url bsc  (or `forge test` with the [rpc_endpoints] alias)
 */
contract AgripinaaYieldRouterForkTest is Test {
    address constant USDT = 0x55d398326f99059fF775485246999027B3197955;
    address constant AUSDT = 0xa9251ca9DE909CB71783723713B21E4233fbf1B1;
    address constant AAVE = 0x6807dc923806fE8Fd134338EABCA509979a7e0cB;
    address constant VUSDT = 0xfD5840Cd36d94D7229439859C0112a4185BC0255;

    uint256 constant PRINCIPAL = 1000e18;
    // Lending redemptions round down by a few wei; principal must survive within dust.
    uint256 constant DUST = 1e12;

    AgripinaaYieldRouter router;
    address user = makeAddr("user");
    address attacker = makeAddr("attacker");

    function setUp() public {
        vm.createSelectFork("bsc");
        router = new AgripinaaYieldRouter(USDT, AUSDT, AAVE, VUSDT);
        deal(USDT, user, PRINCIPAL);
        // The account grants the router the three approvals it needs (done once
        // by the admin passkey at deposit time in production).
        vm.startPrank(user);
        IERC20(USDT).approve(address(router), type(uint256).max);
        IERC20(AUSDT).approve(address(router), type(uint256).max);
        IERC20(VUSDT).approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    function _bal(address token, address who) internal view returns (uint256) {
        return IERC20(token).balanceOf(who);
    }

    function _assertRouterEmpty() internal view {
        assertEq(_bal(USDT, address(router)), 0, "router holds USDT");
        assertEq(_bal(AUSDT, address(router)), 0, "router holds aUSDT");
        assertEq(_bal(VUSDT, address(router)), 0, "router holds vUSDT");
    }

    /// Idle USDT -> Aave: aTokens land in the user's account, router ends empty.
    function test_toAave_movesUsdtIntoUserAavePosition() public {
        vm.prank(user);
        router.toAave();

        assertEq(_bal(USDT, user), 0, "idle USDT not consumed");
        assertApproxEqAbs(_bal(AUSDT, user), PRINCIPAL, DUST, "aUSDT not credited to user");
        _assertRouterEmpty();
    }

    /// Idle USDT -> Venus: vTokens are handed back to the user, router ends empty.
    function test_toVenus_movesUsdtIntoUserVenusPosition() public {
        vm.prank(user);
        router.toVenus();

        assertEq(_bal(USDT, user), 0, "idle USDT not consumed");
        assertGt(_bal(VUSDT, user), 0, "vUSDT not credited to user");
        _assertRouterEmpty();
    }

    /// Full rotation Aave -> Venus -> idle returns the principal to the user.
    function test_rotationRoundTripReturnsPrincipal() public {
        vm.prank(user);
        router.toAave();
        assertApproxEqAbs(_bal(AUSDT, user), PRINCIPAL, DUST, "step1 aUSDT");

        vm.prank(user);
        router.toVenus();
        assertEq(_bal(AUSDT, user), 0, "Aave position not unwound");
        assertGt(_bal(VUSDT, user), 0, "vUSDT not credited");
        _assertRouterEmpty();

        vm.prank(user);
        router.toIdle();
        assertEq(_bal(VUSDT, user), 0, "Venus position not unwound");
        assertApproxEqAbs(_bal(USDT, user), PRINCIPAL, DUST, "principal not returned");
        _assertRouterEmpty();
    }

    /// The core guarantee: a keeper can only ever route the CALLER's own funds
    /// to the CALLER. An attacker calling the router touches only their own
    /// (empty) balances and cannot reach the user's funds.
    function test_attackerCannotTouchAnotherUsersFunds() public {
        vm.prank(user);
        router.toAave();
        uint256 userAaveBefore = _bal(AUSDT, user);

        // Attacker hammers every entrypoint. Each acts on msg.sender == attacker.
        vm.startPrank(attacker);
        router.toIdle();
        router.toAave();
        router.toVenus();
        vm.stopPrank();

        assertEq(_bal(AUSDT, user), userAaveBefore, "user's Aave position changed");
        assertEq(_bal(USDT, attacker), 0, "attacker extracted USDT");
        assertEq(_bal(AUSDT, attacker), 0, "attacker extracted aUSDT");
        assertEq(_bal(VUSDT, attacker), 0, "attacker extracted vUSDT");
        _assertRouterEmpty();
    }

    /// No entrypoint takes a recipient argument, so there is no calldata an
    /// agent could craft to send funds elsewhere. Calling with only the user's
    /// approval, funds always return to the user.
    function test_idleOnEmptyAccountIsNoOp() public {
        vm.prank(attacker);
        router.toIdle();
        assertEq(_bal(USDT, attacker), 0);
        _assertRouterEmpty();
    }

    // --- Delta accounting: stranded funds are never distributed (audit L-1) ---

    /// USDT mis-sent to the router cannot be swept by a zero-balance caller.
    function test_attackerCannotSweepStrayUsdt() public {
        deal(USDT, address(router), 500e18);
        vm.prank(attacker);
        router.toIdle();
        assertEq(_bal(USDT, attacker), 0, "attacker swept stray USDT");
        assertEq(_bal(USDT, address(router)), 500e18, "stray USDT left the router");
    }

    /// A legit user gets back EXACTLY their principal, never principal + stray,
    /// and the stray stays stranded (proves I2/I3 hold with a dirty router).
    function test_strayUsdtIsNotDistributedToUser() public {
        deal(USDT, address(router), 500e18);

        vm.prank(user);
        router.toAave();
        assertApproxEqAbs(_bal(AUSDT, user), PRINCIPAL, DUST, "user credited the stray on deposit");

        vm.prank(user);
        router.toIdle();
        assertApproxEqAbs(_bal(USDT, user), PRINCIPAL, DUST, "user swept the stray on withdraw");
        assertEq(_bal(USDT, address(router)), 500e18, "stray USDT was moved");
    }

    /// The vToken hand-back returns only THIS call's mint, not any stray vToken.
    function test_strayVusdtIsNotHandedToUser() public {
        // Seed the router with vUSDT by supplying from the attacker, then
        // parking those vTokens in the router.
        deal(USDT, attacker, 100e18);
        vm.startPrank(attacker);
        IERC20(USDT).approve(VUSDT, type(uint256).max);
        (bool ok, ) = VUSDT.call(abi.encodeWithSignature("mint(uint256)", uint256(100e18)));
        require(ok, "seed mint failed");
        uint256 strayV = IERC20(VUSDT).balanceOf(attacker);
        IERC20(VUSDT).transfer(address(router), strayV);
        vm.stopPrank();
        assertGt(_bal(VUSDT, address(router)), 0, "router not seeded with stray vUSDT");

        // User rotates into Venus; must receive only their own minted vTokens.
        vm.prank(user);
        router.toVenus();
        assertGt(_bal(VUSDT, user), 0, "user got no vUSDT");
        assertApproxEqAbs(_bal(VUSDT, address(router)), strayV, 1, "stray vUSDT handed to user");
    }
}
