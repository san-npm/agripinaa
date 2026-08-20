// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title AgripinaaYieldRouter
 * @notice A drain-proof adapter that lets a scoped agent session rotate a
 *         user's USDT between Venus and Aave, or back to idle, WITHOUT ever
 *         being able to send funds anywhere but back to the user.
 *
 * Why this exists: Altana/Porto session keys can be scoped to a (target,
 * selector) pair but NOT to call arguments. If an agent could call Aave
 * `withdraw(asset, amount, to)` or ERC-20 `transfer(to, amount)` directly, it
 * could set `to` to itself and drain the account. This router removes that
 * surface: every recipient below is hardcoded to `msg.sender` (the user's own
 * smart account), and it exposes only three zero-argument selectors. A fully
 * compromised agent key can, at worst, shuffle the user's own funds between
 * the user's own positions, or return them idle to the user. It can never
 * move value to a third party.
 *
 * Non-custodial: the router holds no funds between calls. Within one call it
 * pulls a position in, rotates it, and hands the resulting position token (or
 * plain USDT) straight back to the caller, ending every call at a zero
 * balance. The user's funds always live in the user's account as USDT, aToken
 * (Aave), or vToken (Venus).
 *
 * Trust model: non-upgradeable, un-owned, no admin, no privileged role, no
 * `selfdestruct`, no delegatecall. The only powers it needs are the ERC-20
 * approvals the account grants it (USDT + aToken + vToken); those approvals
 * are only ever exercised to move the caller's funds back to the caller.
 */

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IAavePool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}

/// @dev Venus is a Compound-v2 fork: mint/redeem return an error code (0 == ok).
interface IVToken {
    function mint(uint256 mintAmount) external returns (uint256);
    function redeem(uint256 redeemTokens) external returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract AgripinaaYieldRouter {
    IERC20 public immutable USDT;
    IERC20 public immutable AUSDT; // Aave aToken for USDT
    IAavePool public immutable AAVE;
    IVToken public immutable VUSDT; // Venus vToken for USDT

    /// @dev Non-reentrancy: cheap defense in depth. The venue/token addresses
    /// are fixed and trusted, but a guard keeps the "ends at zero balance"
    /// invariant impossible to interleave.
    uint256 private _locked = 1;

    event Rotated(address indexed account, bytes4 indexed action, uint256 usdtAmount);

    error Reentrancy();
    error VenusMintFailed(uint256 code);
    error VenusRedeemFailed(uint256 code);
    error TransferFailed();
    error ApproveFailed();

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(address usdt, address aUsdt, address aavePool, address vUsdt) {
        USDT = IERC20(usdt);
        AUSDT = IERC20(aUsdt);
        AAVE = IAavePool(aavePool);
        VUSDT = IVToken(vUsdt);
    }

    /// @notice Move all of the caller's USDT (unwinding any Venus position) into Aave.
    function toAave() external nonReentrant {
        uint256 amount = _unwindAllToUsdt(msg.sender);
        if (amount > 0) {
            _approve(USDT, address(AAVE), amount);
            // aTokens are minted straight to the user's account.
            AAVE.supply(address(USDT), amount, msg.sender, 0);
        }
        emit Rotated(msg.sender, this.toAave.selector, amount);
    }

    /// @notice Move all of the caller's USDT (unwinding any Aave position) into Venus.
    function toVenus() external nonReentrant {
        uint256 amount = _unwindAllToUsdt(msg.sender);
        if (amount > 0) {
            _approve(USDT, address(VUSDT), amount);
            // Snapshot after unwind (which redeemed any of the caller's own
            // vTokens), so `minted` excludes any stray vToken balance.
            uint256 preMint = VUSDT.balanceOf(address(this));
            uint256 code = VUSDT.mint(amount); // vTokens are minted to this router...
            if (code != 0) revert VenusMintFailed(code);
            // ...so hand exactly this call's newly minted vTokens back to the user.
            uint256 minted = VUSDT.balanceOf(address(this)) - preMint;
            if (!VUSDT.transfer(msg.sender, minted)) revert TransferFailed();
        }
        emit Rotated(msg.sender, this.toVenus.selector, amount);
    }

    /// @notice Unwind everything back to the caller's plain USDT balance (this is "withdraw").
    function toIdle() external nonReentrant {
        uint256 amount = _unwindAllToUsdt(msg.sender);
        if (amount > 0) {
            if (!USDT.transfer(msg.sender, amount)) revert TransferFailed();
        }
        emit Rotated(msg.sender, this.toIdle.selector, amount);
    }

    /**
     * @dev Pull every USDT-equivalent the account holds (Venus vTokens, Aave
     * aTokens, idle USDT) into this router as plain USDT, and return ONLY the
     * amount this call brought in. Everything is pulled FROM `account` TO this
     * router; each step touches only the caller's own position, so any balance
     * stranded in the router beforehand (a stray transfer/donation) is ignored
     * and can never be swept by a caller. This makes the "holds nothing between
     * calls / only your own funds" invariants hold by construction, not by the
     * router happening to be empty.
     */
    function _unwindAllToUsdt(address account) private returns (uint256) {
        // Ignore any pre-existing (stranded) USDT: we distribute the delta only.
        uint256 entryUsdt = USDT.balanceOf(address(this));

        // 1. Venus: pull ONLY the caller's vTokens and redeem exactly those.
        uint256 vBal = VUSDT.balanceOf(account);
        if (vBal > 0) {
            if (!VUSDT.transferFrom(account, address(this), vBal)) revert TransferFailed();
            uint256 code = VUSDT.redeem(vBal);
            if (code != 0) revert VenusRedeemFailed(code);
        }

        // 2. Aave: pull the caller's aTokens and withdraw EXACTLY that amount
        //    (not type(max)), so a stray aToken balance is left untouched.
        uint256 aBal = AUSDT.balanceOf(account);
        if (aBal > 0) {
            if (!AUSDT.transferFrom(account, address(this), aBal)) revert TransferFailed();
            AAVE.withdraw(address(USDT), aBal, address(this));
        }

        // 3. Idle USDT sitting in the account.
        uint256 idle = USDT.balanceOf(account);
        if (idle > 0) {
            if (!USDT.transferFrom(account, address(this), idle)) revert TransferFailed();
        }

        // Only what THIS call brought in — never pre-existing stranded balance.
        return USDT.balanceOf(address(this)) - entryUsdt;
    }

    /// @dev Set an exact allowance, checking the return so a non-standard token
    /// can't silently leave a stale allowance.
    function _approve(IERC20 token, address spender, uint256 amount) private {
        if (!token.approve(spender, 0)) revert ApproveFailed();
        if (!token.approve(spender, amount)) revert ApproveFailed();
    }
}
