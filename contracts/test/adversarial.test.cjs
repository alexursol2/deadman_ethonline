/**
 * The adversarial suite — plan 09.
 *
 * Written to break the contract, not to confirm it. The governing rule from
 * session 04:
 *
 *     Every test must fail first against a deliberately broken version
 *     before it counts.
 *
 * So each guard is tested twice: once against a mutant from Mutants.sol with
 * that guard removed, where the attack MUST succeed, and once against the real
 * contract, where it MUST fail. A mutant that survives means the test proves
 * nothing, and the suite says so rather than going green.
 *
 * What this cannot model: Hedera's own consensus ordering. Section 4.1 uses
 * Hardhat's block control to put claim and refund in one block, which is a
 * faithful test of the compare-and-set and is NOT a race against the real
 * scheduler.
 */
const { expect } = require("chai");
const { ethers, network } = require("hardhat");

const HSS = "0x000000000000000000000000000000000000016b";
const H = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
const KEY = ethers.keccak256(ethers.toUtf8Bytes("the-secret-key"));
const AMOUNT = 1_000_000_000n;
const FUND = 100_000_000_000n;

const now = async () => (await ethers.provider.getBlock("latest")).timestamp;

async function installMock() {
  const mock = await (await ethers.getContractFactory("MockHSS")).deploy();
  await mock.waitForDeployment();
  await network.provider.send("hardhat_setCode", [HSS, await ethers.provider.getCode(await mock.getAddress())]);
  return await ethers.getContractAt("MockHSS", HSS);
}

/**
 * The network calls refund() as the contract itself (C1), so tests impersonate
 * the escrow's own address.
 *
 * The top-up is ADDITIVE. Setting the balance outright — the obvious way to
 * fund an impersonated account for gas — silently destroys the contract's
 * accounting balance, and every payout measured as a balance delta then reads
 * as garbage. Learned the hard way: measure RECIPIENT gains, never the
 * escrow's own balance, in any test that impersonates it.
 */
async function asSelf(address) {
  await network.provider.send("hardhat_impersonateAccount", [address]);
  const current = await ethers.provider.getBalance(address);
  await network.provider.send("hardhat_setBalance", [
    address,
    "0x" + (current + ethers.parseEther("100")).toString(16),
  ]);
  return await ethers.getSigner(address);
}

/**
 * Deploy the real contract or a named mutant, funded and ready.
 *
 * viaFund distinguishes the two ways money reaches this contract, and since the
 * sweep fix they behave differently:
 *
 *   false  a bare balance, as an x402 settlement arrives — credited without
 *          running any code (C12), so it is NOT sweepable float
 *   true   fund(), a deliberate operator top-up, which IS sweepable
 *
 * Tests of the solvency bound need viaFund, or the float guard fires first and
 * they never reach the thing they meant to test.
 */
async function deploy(which, server, viaFund = false) {
  const escrow = await (await ethers.getContractFactory(which)).deploy();
  await escrow.waitForDeployment();
  const address = await escrow.getAddress();
  await escrow.setOpener(server.address, true);
  if (viaFund) {
    await escrow.fund({ value: FUND });
  } else {
    await network.provider.send("hardhat_setBalance", [address, "0x" + FUND.toString(16)]);
  }
  return { escrow, address };
}

async function open(escrow, server, payer, payee, overrides = {}) {
  const p = {
    payer,
    payee,
    amountTinybar: AMOUNT,
    deadline: BigInt((await now()) + 120),
    hKey: ethers.keccak256(KEY),
    hCipher: H("C"),
    hPlain: H("m"),
    hRequest: H(`req-${Math.random()}`),
    ...overrides,
  };
  const rc = await (await escrow.connect(server).openHold(p)).wait();
  const ev = rc.logs
    .map((l) => {
      try {
        return escrow.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((e) => e && e.name === "HoldOpened");
  return { holdId: ev.args.holdId, armedDeadline: ev.args.armedDeadline, ev };
}

describe("adversarial", function () {
  let owner, server, payer, payee, mock;

  beforeEach(async function () {
    await network.provider.send("hardhat_reset");
    [owner, server, payer, payee] = await ethers.getSigners();
    mock = await installMock();
  });

  /* ═══════════════ 4.1 claim and refund in the same second ═══════════════ */
  describe("4.1 claim and refund in the same block", function () {
    /**
     * Puts both transactions in ONE block so neither can observe the other's
     * receipt. Returns how much value actually left the contract.
     */
    async function raceInOneBlock(which, claimFirst) {
      const { escrow, address } = await deploy(which, server);
      const { holdId } = await open(escrow, server, payer.address, payee.address);
      const self = await asSelf(address);
      const hold = await escrow.getHold(holdId);

      // Recipients are plain EOAs paying no gas in this block, so their gains
      // are exactly what the contract paid out.
      const payeeBefore = await ethers.provider.getBalance(payee.address);
      const payerBefore = await ethers.provider.getBalance(payer.address);

      await network.provider.send("evm_setAutomine", [false]);
      const sent = [];
      const push = async (fn) => {
        try {
          sent.push(await fn());
        } catch (e) {
          sent.push(null); // rejected before it reached the block
        }
      };
      if (claimFirst) {
        await push(() => escrow.connect(server).claim(holdId, KEY, { gasLimit: 2_000_000 }));
        await push(() => escrow.connect(self).refund(holdId, hold.deadline, { gasLimit: 2_000_000 }));
      } else {
        await push(() => escrow.connect(self).refund(holdId, hold.deadline, { gasLimit: 2_000_000 }));
        await push(() => escrow.connect(server).claim(holdId, KEY, { gasLimit: 2_000_000 }));
      }
      await network.provider.send("evm_mine");
      await network.provider.send("evm_setAutomine", [true]);

      const statuses = [];
      for (const tx of sent) {
        if (!tx) {
          statuses.push("rejected");
          continue;
        }
        const rc = await ethers.provider.getTransactionReceipt(tx.hash);
        statuses.push(rc && rc.status === 1 ? "ok" : "reverted");
      }

      const payeeGained = (await ethers.provider.getBalance(payee.address)) - payeeBefore;
      const payerGained = (await ethers.provider.getBalance(payer.address)) - payerBefore;
      return { escrow, holdId, statuses, payeeGained, payerGained, paidOut: payeeGained + payerGained };
    }

    for (const claimFirst of [true, false]) {
      const order = claimFirst ? "claim submitted first" : "refund submitted first";

      it(`MUTANT NoCasCheck alone still pays once — defence in depth — ${order}`, async function () {
        // This is NOT the result the test was written expecting, and the
        // discrepancy is the finding. Removing the compare-and-set is not
        // enough: the second entry reads amountTinybar as 0 and pays nothing,
        // and openHoldCount underflows and reverts. Two further guards catch it.
        //
        // Kept as an assertion rather than deleted, because "the CAS is what
        // stops the double payout" is the sentence this test was going to
        // justify, and it is not true on its own.
        const r = await raceInOneBlock("NoCasCheck", claimFirst);
        expect(r.paidOut).to.equal(AMOUNT);
      });

      it(`MUTANT NoCasNoZero pays out TWICE — ${order}`, async function () {
        // CAS removed AND the amount left standing. Only now does one hold pay
        // twice, which is what proves the pair of guards is load-bearing.
        const r = await raceInOneBlock("NoCasNoZero", claimFirst);
        expect(r.paidOut).to.equal(AMOUNT * 2n);
        expect(r.payeeGained).to.equal(AMOUNT);
        expect(r.payerGained).to.equal(AMOUNT);
      });

      it(`real contract pays out exactly ONCE — ${order}`, async function () {
        const r = await raceInOneBlock("HoldEscrow", claimFirst);
        expect(r.paidOut).to.equal(AMOUNT);
        // Exactly one recipient is paid, and it is whichever the block ordered
        // first — we do not get to choose, and the test does not assume.
        const paid = [r.payeeGained, r.payerGained].filter((v) => v === AMOUNT);
        expect(paid.length).to.equal(1);
        // The loser reverted rather than silently doing nothing.
        expect(r.statuses.filter((s) => s === "ok").length).to.equal(1);
        expect(r.statuses.filter((s) => s !== "ok").length).to.equal(1);
        const hold = await r.escrow.getHold(r.holdId);
        expect([2n, 3n]).to.include(hold.status);
        expect(hold.amountTinybar).to.equal(0n);
      });
    }

    it("the loser cannot re-enter afterwards", async function () {
      const r = await raceInOneBlock("HoldEscrow", true);
      const hold = await r.escrow.getHold(r.holdId);
      const self = await asSelf(await r.escrow.getAddress());
      await expect(r.escrow.connect(server).claim(r.holdId, KEY)).to.be.revertedWithCustomError(
        r.escrow,
        "BadState",
      );
      await expect(r.escrow.connect(self).refund(r.holdId, hold.deadline)).to.be.revertedWithCustomError(
        r.escrow,
        "BadState",
      );
    });
  });

  /* ═════════════════ 4.2 a sweep must not reach an open hold ═════════════ */
  describe("4.2 sweepReserve vs held funds", function () {
    it("cannot sweep the balance while a hold is OPEN", async function () {
      const { escrow } = await deploy("HoldEscrow", server, true);
      await open(escrow, server, payer.address, payee.address);
      const free = await escrow.freeTinybar();
      await expect(escrow.sweepReserve(owner.address, free)).to.be.revertedWithCustomError(
        escrow,
        "WouldBreakSolvency",
      );
    });

    it("cannot sweep so far that armed refunds become unfundable", async function () {
      const { escrow } = await deploy("HoldEscrow", server, true);
      for (let i = 0; i < 3; i++) await open(escrow, server, payer.address, payee.address);
      const required = await escrow.requiredReserveTinybar();
      const free = await escrow.freeTinybar();
      // Anything that would leave less than the scaled reserve must be refused.
      await expect(escrow.sweepReserve(owner.address, free - required + 1n)).to.be.revertedWithCustomError(
        escrow,
        "WouldBreakSolvency",
      );
      // And the largest legal sweep is allowed, so the guard is a bound and not a ban.
      await expect(escrow.sweepReserve(owner.address, free - required)).to.not.be.reverted;
    });

    it("MUTANT FlatReserve lets a sweep strand armed refunds", async function () {
      const { escrow } = await deploy("FlatReserve", server, true);
      for (let i = 0; i < 3; i++) await open(escrow, server, payer.address, payee.address);
      const free = await escrow.freeTinybar();
      const flat = await escrow.minOperatingReserveTinybar();
      const deposit = await escrow.refundGasDepositTinybar();
      const openCount = await escrow.openHoldCount();
      // What the REAL contract would have required. Asking the mutant's own
      // requiredReserveTinybar() would be asking the bug whether it is a bug.
      const correctlyRequired = flat + openCount * deposit;

      await expect(escrow.sweepReserve(owner.address, free - flat)).to.not.be.reverted;
      expect(await escrow.freeTinybar()).to.be.lessThan(correctlyRequired);
    });

    /**
     * THE WINDOW. Money has settled into the contract and openHold has not run
     * yet, so it is attributed to nothing and a balance-based "free" counts it.
     *
     * This test FOUND A REAL BUG. Before the fix, sweepReserve could take a
     * buyer's settled payment out of that window. The fix tracks deliberately
     * deposited float separately, so money that arrived without executing code
     * is never sweepable.
     */
    it("settled-but-unarmed funds CANNOT be swept", async function () {
      const { escrow, address } = await deploy("HoldEscrow", server);
      const before = await ethers.provider.getBalance(address);
      // A buyer settles. No call into the contract — that is how HAPI works (C12).
      await network.provider.send("hardhat_setBalance", [address, "0x" + (before + AMOUNT).toString(16)]);

      // "free" still counts it, and that is correct: openHold has to see it.
      expect(await escrow.freeTinybar()).to.equal(before + AMOUNT);
      // But none of it was deliberately deposited, so none of it is sweepable.
      expect(await escrow.operatingFloatTinybar()).to.equal(0n);
      await expect(escrow.sweepReserve(payee.address, AMOUNT)).to.be.revertedWithCustomError(
        escrow,
        "ExceedsOperatingFloat",
      );
      expect(await ethers.provider.getBalance(address)).to.equal(before + AMOUNT);
    });

    it("a sweep cannot exceed the deliberate float even when the balance is large", async function () {
      const { escrow, address } = await deploy("HoldEscrow", server);
      await escrow.fund({ value: 10_000_000n }); // a small, deliberate float
      // A large settled payment arrives without executing code.
      const bal = await ethers.provider.getBalance(address);
      await network.provider.send("hardhat_setBalance", [address, "0x" + (bal + AMOUNT * 10n).toString(16)]);

      await expect(escrow.sweepReserve(owner.address, 10_000_001n)).to.be.revertedWithCustomError(
        escrow,
        "ExceedsOperatingFloat",
      );
      await expect(escrow.sweepReserve(owner.address, 10_000_000n)).to.not.be.reverted;
      expect(await escrow.operatingFloatTinybar()).to.equal(0n);
    });

    it("gas spent on refunds does not leave the float overstated", async function () {
      // The contract pays scheduled-refund gas out of its own balance and cannot
      // observe that spend, so the float drifts above reality. An overstated
      // float would re-open the hole it was added to close.
      const { escrow, address } = await deploy("HoldEscrow", server, true);
      const { holdId } = await open(escrow, server, payer.address, payee.address);

      // Simulate execution gas leaving the balance.
      const bal = await ethers.provider.getBalance(address);
      await network.provider.send("hardhat_setBalance", [address, "0x" + (bal - 5_000_000n).toString(16)]);
      expect(await escrow.operatingFloatTinybar()).to.be.greaterThan(await escrow.freeTinybar());

      // Opening the next hold reconciles it, and a sweep cannot exceed reality.
      await network.provider.send("hardhat_setBalance", [
        address,
        "0x" + ((await ethers.provider.getBalance(address)) + AMOUNT).toString(16),
      ]);
      await open(escrow, server, payer.address, payee.address);
      const float = await escrow.operatingFloatTinybar();
      expect(float).to.be.lessThanOrEqual(await escrow.freeTinybar());
      holdId;
    });

    it("the orphan path, not the sweep, is how settled-but-unarmed money gets out", async function () {
      const { escrow, address } = await deploy("HoldEscrow", server);
      const before = await ethers.provider.getBalance(address);
      await network.provider.send("hardhat_setBalance", [address, "0x" + (before + AMOUNT).toString(16)]);

      // It goes back to the payer as a credit, never to the owner as a sweep.
      await expect(escrow.attributeOrphanedPayment(payer.address, AMOUNT, "settlement never armed")).to.emit(
        escrow,
        "OrphanAttributed",
      );
      expect(await escrow.withdrawableTinybar(payer.address)).to.equal(AMOUNT);
    });
  });

  /* ══════════ 4.3 refund must never revert after its transition ══════════ */
  describe("4.3 refund cannot revert after the state transition", function () {
    const hostiles = [
      ["RejectingRecipient", "reverts immediately"],
      ["GasBurningRecipient", "consumes all the gas it is given"],
      ["NoReceiver", "has neither receive nor fallback"],
    ];

    for (const [factory, description] of hostiles) {
      it(`real contract credits instead of reverting — payer ${description}`, async function () {
        const { escrow, address } = await deploy("HoldEscrow", server);
        const hostile = await (await ethers.getContractFactory(factory)).deploy();
        await hostile.waitForDeployment();
        const bad = await hostile.getAddress();

        const { holdId } = await open(escrow, server, bad, payee.address);
        const hold = await escrow.getHold(holdId);
        const self = await asSelf(address);

        await expect(escrow.connect(self).refund(holdId, hold.deadline)).to.emit(escrow, "PayoutDeferred");

        expect((await escrow.getHold(holdId)).status).to.equal(3); // REFUNDED, not stuck
        expect(await escrow.withdrawableTinybar(bad)).to.equal(AMOUNT);
      });

      it(`MUTANT PushOrRevert strands the hold — payer ${description}`, async function () {
        const { escrow, address } = await deploy("PushOrRevert", server);
        const hostile = await (await ethers.getContractFactory(factory)).deploy();
        await hostile.waitForDeployment();
        const bad = await hostile.getAddress();

        const { holdId } = await open(escrow, server, bad, payee.address);
        const hold = await escrow.getHold(holdId);
        const self = await asSelf(address);

        await expect(escrow.connect(self).refund(holdId, hold.deadline)).to.be.reverted;
        // The schedule is spent on a real network (spike 8), so this hold is
        // stranded OPEN with nothing armed. Nobody can ever get the money.
        expect((await escrow.getHold(holdId)).status).to.equal(1); // still OPEN
      });
    }
  });

  /* ═══════════ 4.4 double payout via a refused deleteSchedule ════════════ */
  describe("4.4 a refused deleteSchedule must not allow a double payout", function () {
    it("real contract refuses the claim, leaving the refund armed", async function () {
      const { escrow, address } = await deploy("HoldEscrow", server);
      const { holdId } = await open(escrow, server, payer.address, payee.address);
      await mock.setDeleteCode(7); // INVALID_SIGNATURE

      await expect(escrow.connect(server).claim(holdId, KEY)).to.be.revertedWithCustomError(
        escrow,
        "HssNotSuccess",
      );
      expect((await escrow.getHold(holdId)).status).to.equal(1); // OPEN

      // The refund then fires normally and pays exactly once.
      const hold = await escrow.getHold(holdId);
      const self = await asSelf(address);
      const payerBefore = await ethers.provider.getBalance(payer.address);
      await escrow.connect(self).refund(holdId, hold.deadline);
      expect((await ethers.provider.getBalance(payer.address)) - payerBefore).to.equal(AMOUNT);
    });

    it("MUTANT IgnoresDeleteCode pays the payee AND the payer — a double payout", async function () {
      const { escrow, address } = await deploy("IgnoresDeleteCode", server);
      const { holdId } = await open(escrow, server, payer.address, payee.address);
      await mock.setDeleteCode(7);

      const payeeBefore = await ethers.provider.getBalance(payee.address);

      // The delete is refused and discarded, so the claim "succeeds".
      await escrow.connect(server).claim(holdId, KEY);
      expect((await escrow.getHold(holdId)).status).to.equal(2); // CLAIMED
      expect((await ethers.provider.getBalance(payee.address)) - payeeBefore).to.equal(AMOUNT);

      // On a real network the schedule was never deleted, so it still fires.
      // Here the CAS stops it — which is the second line of defence, and the
      // reason this mutant does not cost real money in THIS harness. What it
      // proves is that the seller was paid on a hold whose refund is still armed.
      const hold = await escrow.getHold(holdId);
      const self = await asSelf(address);
      await expect(escrow.connect(self).refund(holdId, hold.deadline)).to.be.revertedWithCustomError(
        escrow,
        "BadState",
      );

      // The damage is real even so: the payee was paid on a hold whose schedule
      // was never actually deleted, so on a real network that refund is still
      // armed and will fire against a contract that believes it is settled.
      expect((await ethers.provider.getBalance(payee.address)) - payeeBefore).to.equal(AMOUNT);
    });
  });

  /* ═════════ 4.6 the seven-step flow, as tests rather than a paragraph ═══ */
  describe("4.6 the server's step order is load-bearing", function () {
    it("openHold BEFORE settlement is refused — the money is not there yet", async function () {
      const escrow = await (await ethers.getContractFactory("HoldEscrow")).deploy();
      await escrow.waitForDeployment();
      await escrow.setOpener(server.address, true);
      // No settlement: the contract holds nothing.
      await expect(open(escrow, server, payer.address, payee.address)).to.be.revertedWithCustomError(
        escrow,
        "Underfunded",
      );
    });

    it("a second hold cannot be opened against the same settled funds", async function () {
      const { escrow, address } = await deploy("HoldEscrow", server);
      await network.provider.send("hardhat_setBalance", [
        address,
        "0x" + (AMOUNT + (await escrow.refundGasDepositTinybar()) + (await escrow.minOperatingReserveTinybar())).toString(16),
      ]);
      await open(escrow, server, payer.address, payee.address);
      // The funds are now locked to hold 1; a second openHold has nothing to attribute.
      await expect(open(escrow, server, payer.address, payee.address)).to.be.revertedWithCustomError(
        escrow,
        "Underfunded",
      );
    });
  });
});
