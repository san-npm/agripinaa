// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AgripinaaYieldRouter} from "../../src/AgripinaaYieldRouter.sol";

/**
 * Stateful invariant fuzzing (Echidna + Medusa) of AgripinaaYieldRouter against
 * faithful mocks of BSC USDT (bool-returning ERC20), Aave V3 (onBehalfOf mint,
 * max-withdraw), and Venus (Compound-v2 fork: mint/redeem return error codes,
 * mint credits the caller). All venues are 1:1 so token balances equal USDT
 * value exactly, which lets the invariants be strict equalities/bounds.
 *
 * The fuzzer drives deposits, rotations, withdrawals, and out-of-band DONATIONS
 * across three independent actors. The two properties it must never break:
 *   - no actor can ever hold more value than they deposited (drain-proof: an
 *     attacker with zero deposits can never end with anything, and no one can
 *     sweep stranded/donated funds — this is exactly audit finding L-1);
 *   - the router never custodies more than what was donated to it.
 */

contract MockERC20 {
    string public name;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    address public underlyingAddress;
    address public poolAddress;

    constructor(string memory n) {
        name = n;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transfer(address t, uint256 a) external returns (bool) {
        _xfer(msg.sender, t, a);
        return true;
    }

    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        uint256 al = allowance[f][msg.sender];
        if (al != type(uint256).max) {
            require(al >= a, "allowance");
            allowance[f][msg.sender] = al - a;
        }
        _xfer(f, t, a);
        return true;
    }

    function _xfer(address f, address t, uint256 a) internal {
        require(balanceOf[f] >= a, "balance");
        balanceOf[f] -= a;
        balanceOf[t] += a;
    }

    function mintTo(address to, uint256 a) public {
        balanceOf[to] += a;
        totalSupply += a;
    }

    function burnFrom(address from, uint256 a) public {
        require(balanceOf[from] >= a, "balance");
        balanceOf[from] -= a;
        totalSupply -= a;
    }

    function setDependencies(address underlying_, address pool_) external {
        underlyingAddress = underlying_;
        poolAddress = pool_;
    }

    function UNDERLYING_ASSET_ADDRESS() external view returns (address) {
        return underlyingAddress;
    }

    function POOL() external view returns (address) {
        return poolAddress;
    }
}

/// Aave-like pool: supply mints aTokens 1:1 to onBehalfOf; withdraw burns the
/// caller's aTokens and sends underlying to `to` (type(max) == full balance).
contract MockAavePool {
    MockERC20 public usdt;
    MockERC20 public aToken;
    mapping(address => uint256) public debtBase;

    constructor(MockERC20 _usdt, MockERC20 _aToken) {
        usdt = _usdt;
        aToken = _aToken;
    }

    function supply(address, uint256 amount, address onBehalfOf, uint16) external {
        usdt.transferFrom(msg.sender, address(this), amount);
        aToken.mintTo(onBehalfOf, amount);
    }

    function withdraw(address, uint256 amount, address to) external returns (uint256) {
        uint256 bal = aToken.balanceOf(msg.sender);
        uint256 amt = amount == type(uint256).max ? bal : amount;
        require(bal >= amt, "aBalance");
        aToken.burnFrom(msg.sender, amt);
        usdt.transfer(to, amt);
        return amt;
    }

    function setDebt(address account, uint256 amount) external {
        debtBase[account] = amount;
    }

    function getUserAccountData(address account)
        external
        view
        returns (uint256, uint256, uint256, uint256, uint256, uint256)
    {
        return (0, debtBase[account], 0, 0, 0, type(uint256).max);
    }
}

/// Venus-like vToken (Compound-v2 fork): mint/redeem return an error code (0 ok),
/// mint credits the caller. 1:1 exchange rate.
contract MockVToken is MockERC20 {
    MockERC20 public usdt;
    mapping(address => uint256) public marketDebt;
    mapping(address => uint256) public vaiDebt;
    address public activeComptroller;

    constructor(MockERC20 _usdt) MockERC20("vUSDT") {
        usdt = _usdt;
        activeComptroller = address(this);
    }

    function mint(uint256 mintAmount) external returns (uint256) {
        usdt.transferFrom(msg.sender, address(this), mintAmount);
        mintTo(msg.sender, mintAmount);
        return 0;
    }

    function redeem(uint256 redeemTokens) external returns (uint256) {
        require(balanceOf[msg.sender] >= redeemTokens, "vBalance");
        burnFrom(msg.sender, redeemTokens);
        usdt.transfer(msg.sender, redeemTokens);
        return 0;
    }

    function underlying() external view returns (address) {
        return address(usdt);
    }

    function comptroller() external view returns (address) {
        return activeComptroller;
    }

    function setDebt(address account, uint256 ordinaryDebt, uint256 syntheticDebt) external {
        marketDebt[account] = ordinaryDebt;
        vaiDebt[account] = syntheticDebt;
    }

    function getAssetsIn(address account) external view returns (address[] memory markets) {
        if (marketDebt[account] != 0) {
            markets = new address[](1);
            markets[0] = address(this);
        }
    }

    function borrowBalanceStored(address account) external view returns (uint256) {
        return marketDebt[account];
    }

    function mintedVAIs(address account) external view returns (uint256) {
        return vaiDebt[account];
    }
}

/// One fund owner. Calls the router so msg.sender (the account) is this actor.
contract Actor {
    AgripinaaYieldRouter public router;

    constructor(AgripinaaYieldRouter r, address usdt, address aToken, address vToken) {
        router = r;
        MockERC20(usdt).approve(address(r), type(uint256).max);
        MockERC20(aToken).approve(address(r), type(uint256).max);
        MockERC20(vToken).approve(address(r), type(uint256).max);
    }

    function toAave() external {
        router.toAave();
    }

    function toVenus() external {
        router.toVenus();
    }

    function toIdle() external {
        router.toIdle();
    }
}

contract RouterFuzz {
    MockERC20 internal usdt;
    MockERC20 internal aToken;
    MockAavePool internal aave;
    MockVToken internal vToken;
    AgripinaaYieldRouter internal router;
    Actor[3] internal actors;

    mapping(address => uint256) public deposited;
    uint256 public donated;

    constructor() {
        usdt = new MockERC20("USDT");
        aToken = new MockERC20("aUSDT");
        vToken = new MockVToken(usdt);
        aave = new MockAavePool(usdt, aToken);
        aToken.setDependencies(address(usdt), address(aave));
        router = new AgripinaaYieldRouter(address(usdt), address(aToken), address(aave), address(vToken));
        for (uint256 i = 0; i < 3; i++) {
            actors[i] = new Actor(router, address(usdt), address(aToken), address(vToken));
        }
    }

    function _actor(uint8 who) internal view returns (Actor) {
        return actors[who % 3];
    }

    // --- fuzzed actions ---

    function deposit(uint8 who, uint96 amt) external {
        uint256 a = (uint256(amt) % 1_000_000e18) + 1;
        Actor act = _actor(who);
        usdt.mintTo(address(act), a);
        deposited[address(act)] += a;
    }

    function goAave(uint8 who) external {
        _actor(who).toAave();
    }

    function goVenus(uint8 who) external {
        _actor(who).toVenus();
    }

    function goIdle(uint8 who) external {
        _actor(who).toIdle();
    }

    /// Exercise the receipt-donation boundary while Aave reports debt. The
    /// donated receipt must remain untouched and the unrelated idle leg must
    /// still complete instead of reverting the entire router action.
    function encumberedAaveReceiptCannotBlockIdle(uint8 who, uint96 amt) external {
        Actor act = _actor(who);
        uint256 idleGift = (uint256(amt) % 1_000e18) + 1;
        usdt.mintTo(address(act), idleGift);
        aToken.mintTo(address(act), 1);
        deposited[address(act)] += idleGift + 1;
        aave.setDebt(address(act), 1);
        uint256 idleBefore = usdt.balanceOf(address(act));
        uint256 protectedBefore = aToken.balanceOf(address(act));
        (bool ok,) = address(act).call(abi.encodeCall(Actor.toIdle, ()));
        assert(ok);
        // Another debt-free venue may also unwind, so idle can increase. The
        // debt-guard invariant is that no idle value is lost and this exact
        // encumbered receipt leg does not move.
        assert(usdt.balanceOf(address(act)) >= idleBefore);
        assert(aToken.balanceOf(address(act)) == protectedBefore);
    }

    /// Synthetic VAI debt is a separate Comptroller ledger. It must protect
    /// the Venus receipt while allowing unrelated idle stablecoin to move.
    function vaiDebtCannotBlockIdle(uint8 who, uint96 amt) external {
        Actor act = _actor(who);
        uint256 idleGift = (uint256(amt) % 1_000e18) + 1;
        usdt.mintTo(address(act), idleGift);
        vToken.mintTo(address(act), 1);
        deposited[address(act)] += idleGift + 1;
        vToken.setDebt(address(act), 0, 1);
        uint256 idleBefore = usdt.balanceOf(address(act));
        uint256 protectedBefore = vToken.balanceOf(address(act));
        (bool ok,) = address(act).call(abi.encodeCall(Actor.toIdle, ()));
        assert(ok);
        assert(usdt.balanceOf(address(act)) >= idleBefore);
        assert(vToken.balanceOf(address(act)) == protectedBefore);
    }

    /// Out-of-band donation of USDT straight into the router (the L-1 setup).
    function donate(uint96 amt) external {
        uint256 a = uint256(amt) % 1_000e18;
        usdt.mintTo(address(router), a);
        donated += a;
    }

    // --- invariants (1:1 venues → balances equal USDT value) ---

    function _value(address a) internal view returns (uint256) {
        return usdt.balanceOf(a) + aToken.balanceOf(a) + vToken.balanceOf(a);
    }

    /// No actor can ever hold more value than they deposited. Drain-proof +
    /// L-1: an attacker with zero deposits stays at zero; nobody sweeps
    /// stranded/donated funds or another actor's principal.
    function echidna_no_actor_exceeds_deposits() external view returns (bool) {
        for (uint256 i = 0; i < 3; i++) {
            address a = address(actors[i]);
            if (_value(a) > deposited[a]) return false;
        }
        return true;
    }

    /// The router never custodies more than what was donated to it.
    function echidna_router_holds_only_donations() external view returns (bool) {
        uint256 held =
            usdt.balanceOf(address(router)) + aToken.balanceOf(address(router)) + vToken.balanceOf(address(router));
        return held <= donated;
    }
}
