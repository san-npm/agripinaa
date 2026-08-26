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
 * Non-custodial: within one call the router pulls a safe source leg in, rotates
 * it, and hands the resulting position token (or plain USDT) straight back to
 * the caller. It retains none of that call's funds. Tokens transferred to the
 * router out of band remain deliberately stranded and are excluded by delta
 * accounting; a later caller cannot sweep them. The user's managed funds live
 * in the user's account as USDT, aToken (Aave), or vToken (Venus).
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
    function getUserAccountData(address user)
        external
        view
        returns (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        );
}

interface IAaveAToken {
    function UNDERLYING_ASSET_ADDRESS() external view returns (address);
    function POOL() external view returns (address);
}

interface IVenusComptroller {
    function getAssetsIn(address account) external view returns (address[] memory);
    function mintedVAIs(address account) external view returns (uint256);
}

/// @dev Venus is a Compound-v2 fork: mint/redeem return an error code (0 == ok).
interface IVToken {
    function mint(uint256 mintAmount) external returns (uint256);
    function redeem(uint256 redeemTokens) external returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function borrowBalanceStored(address account) external view returns (uint256);
    function comptroller() external view returns (address);
    function underlying() external view returns (address);
}

contract AgripinaaYieldRouter {
    uint256 public constant DEBT_GUARD_VERSION = 3;

    enum Target {
        IDLE,
        AAVE,
        VENUS
    }

    IERC20 public immutable USDT;
    IERC20 public immutable AUSDT; // Aave aToken for USDT
    IAavePool public immutable AAVE;
    IVToken public immutable VUSDT; // Venus vToken for USDT
    IVenusComptroller public immutable VENUS_COMPTROLLER;

    /// @dev Non-reentrancy: cheap defense in depth. The venue/token addresses
    /// are fixed and trusted, but a guard keeps the "ends at zero balance"
    /// invariant impossible to interleave.
    uint256 private _locked = 1;

    event Rotated(address indexed account, bytes4 indexed action, uint256 usdtAmount);
    event EncumberedPositionSkipped(
        address indexed account, address indexed receiptToken, address indexed debtSource, uint256 debtAmount
    );

    error Reentrancy();
    error VenusMintFailed(uint256 code);
    error VenusRedeemFailed(uint256 code);
    error ZeroVenusMint();
    error AaveWithdrawMismatch(uint256 expected, uint256 actual);
    error TransferFailed();
    error ApproveFailed();
    error InvalidDependency(address dependency);
    error UnderlyingMismatch(address receiptToken, address expected, address actual);
    error PoolMismatch(address receiptToken, address expected, address actual);
    error ComptrollerMismatch(address expected, address actual);

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(address usdt, address aUsdt, address aavePool, address vUsdt) {
        _requireContract(usdt);
        _requireContract(aUsdt);
        _requireContract(aavePool);
        _requireContract(vUsdt);

        address aaveUnderlying = IAaveAToken(aUsdt).UNDERLYING_ASSET_ADDRESS();
        if (aaveUnderlying != usdt) revert UnderlyingMismatch(aUsdt, usdt, aaveUnderlying);
        address tokenPool = IAaveAToken(aUsdt).POOL();
        if (tokenPool != aavePool) revert PoolMismatch(aUsdt, aavePool, tokenPool);
        address venusUnderlying = IVToken(vUsdt).underlying();
        if (venusUnderlying != usdt) revert UnderlyingMismatch(vUsdt, usdt, venusUnderlying);
        address venusComptroller = IVToken(vUsdt).comptroller();
        _requireContract(venusComptroller);
        // This router is for the Venus Core Pool, whose VAI debt ledger is part
        // of the safety predicate. Probe the selector now so an incompatible
        // isolated-pool Comptroller cannot deploy a router that bricks later.
        if (IVenusComptroller(venusComptroller).mintedVAIs(address(this)) != 0) {
            revert InvalidDependency(venusComptroller);
        }

        USDT = IERC20(usdt);
        AUSDT = IERC20(aUsdt);
        AAVE = IAavePool(aavePool);
        VUSDT = IVToken(vUsdt);
        VENUS_COMPTROLLER = IVenusComptroller(venusComptroller);
    }

    /// @notice Move all of the caller's USDT (unwinding any Venus position) into Aave.
    function toAave() external nonReentrant {
        // Existing Aave receipts are already at the destination. Only unwind
        // Venus and collect idle USDT, avoiding churn and unrelated Aave risk.
        uint256 amount = _collectUsdt(msg.sender, Target.AAVE);
        if (amount > 0) {
            _approve(USDT, address(AAVE), amount);
            // aTokens are minted straight to the user's account.
            AAVE.supply(address(USDT), amount, msg.sender, 0);
        }
        if (amount > 0) emit Rotated(msg.sender, this.toAave.selector, amount);
    }

    /// @notice Move all of the caller's USDT (unwinding any Aave position) into Venus.
    function toVenus() external nonReentrant {
        // Existing Venus receipts are already at the destination. Only unwind
        // Aave and collect idle USDT, avoiding churn and unrelated Venus risk.
        uint256 amount = _collectUsdt(msg.sender, Target.VENUS);
        if (amount > 0) {
            _approve(USDT, address(VUSDT), amount);
            // Snapshot after unwind (which redeemed any of the caller's own
            // vTokens), so `minted` excludes any stray vToken balance.
            uint256 preMint = VUSDT.balanceOf(address(this));
            uint256 code = VUSDT.mint(amount); // vTokens are minted to this router...
            if (code != 0) revert VenusMintFailed(code);
            // ...so hand exactly this call's newly minted vTokens back to the user.
            uint256 minted = VUSDT.balanceOf(address(this)) - preMint;
            if (minted == 0) revert ZeroVenusMint();
            if (!VUSDT.transfer(msg.sender, minted)) revert TransferFailed();
        }
        if (amount > 0) emit Rotated(msg.sender, this.toVenus.selector, amount);
    }

    /// @notice Unwind everything back to the caller's plain USDT balance (this is "withdraw").
    function toIdle() external nonReentrant {
        // Idle USDT is already at the destination. Do not round-trip it through
        // the router: that was a zero-state-change way to manufacture events.
        uint256 amount = _collectUsdt(msg.sender, Target.IDLE);
        if (amount > 0) {
            if (!USDT.transfer(msg.sender, amount)) revert TransferFailed();
        }
        if (amount > 0) emit Rotated(msg.sender, this.toIdle.selector, amount);
    }

    /**
     * @dev Pull the account's safe source legs for `target` into this router as
     * plain USDT and return ONLY the amount this call brought in. The target
     * leg is never round-tripped, and an encumbered source leg remains in the
     * account while other legs continue. Every transfer is FROM `account` TO
     * this router; any balance stranded here beforehand (a stray transfer or
     * donation) is ignored and can never be swept by a later caller.
     */
    function _collectUsdt(address account, Target target) private returns (uint256) {
        // Ignore any pre-existing (stranded) USDT: we distribute the delta only.
        uint256 entryUsdt = USDT.balanceOf(address(this));

        // 1. Venus: pull ONLY the caller's vTokens and redeem exactly those.
        uint256 vBal = VUSDT.balanceOf(account);
        if (target != Target.VENUS && vBal > 0) {
            (address debtSource, uint256 debtAmount) = _venusDebt(account);
            if (debtAmount != 0) {
                // Receipt balances are permissionlessly transferable. Leaving
                // an encumbered leg untouched prevents one donated raw unit
                // from blocking safe Aave/idle processing for the account.
                emit EncumberedPositionSkipped(account, address(VUSDT), debtSource, debtAmount);
            } else {
                if (!VUSDT.transferFrom(account, address(this), vBal)) revert TransferFailed();
                uint256 code = VUSDT.redeem(vBal);
                if (code != 0) revert VenusRedeemFailed(code);
            }
        }

        // 2. Aave: pull the caller's aTokens and withdraw EXACTLY that amount
        //    (not type(max)), so a stray aToken balance is left untouched.
        uint256 aBal = AUSDT.balanceOf(account);
        if (target != Target.AAVE && aBal > 0) {
            (, uint256 debtBase,,,,) = AAVE.getUserAccountData(account);
            if (debtBase != 0) {
                emit EncumberedPositionSkipped(account, address(AUSDT), address(AAVE), debtBase);
            } else {
                if (!AUSDT.transferFrom(account, address(this), aBal)) revert TransferFailed();
                uint256 withdrawn = AAVE.withdraw(address(USDT), aBal, address(this));
                if (withdrawn != aBal) revert AaveWithdrawMismatch(aBal, withdrawn);
            }
        }

        // 3. Idle USDT sitting in the account.
        uint256 idle = USDT.balanceOf(account);
        if (target != Target.IDLE && idle > 0) {
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

    /// @dev Return the first Venus obligation that makes vUSDT unsafe to move.
    /// VAI debt lives in the Comptroller, not in any vToken borrow balance, so
    /// both ledgers are required for a complete zero-debt predicate.
    function _venusDebt(address account) private view returns (address debtSource, uint256 debtAmount) {
        address comptroller = address(VENUS_COMPTROLLER);
        address liveComptroller = VUSDT.comptroller();
        if (liveComptroller != comptroller) revert ComptrollerMismatch(comptroller, liveComptroller);
        uint256 vaiDebt = VENUS_COMPTROLLER.mintedVAIs(account);
        if (vaiDebt != 0) return (comptroller, vaiDebt);
        address[] memory markets = VENUS_COMPTROLLER.getAssetsIn(account);
        for (uint256 i; i < markets.length; ++i) {
            uint256 debt = IVToken(markets[i]).borrowBalanceStored(account);
            if (debt != 0) return (markets[i], debt);
        }
        return (address(0), 0);
    }

    function _requireContract(address dependency) private view {
        if (dependency == address(0) || dependency.code.length == 0) {
            revert InvalidDependency(dependency);
        }
    }
}
