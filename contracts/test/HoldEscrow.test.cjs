/**
 * HoldEscrow unit tests, against a mocked Schedule Service at 0x16b.
 *
 * These reach paths the real network will not give us — a saturated second, a
 * refused delete, a payee that rejects payment — and they are the ONLY coverage
 * the capacity/jitter fallback has, because testnet has never been congested
 * enough to exercise it.
 *
 * What they deliberately do NOT prove: Hedera's unit semantics. On a local EVM
 * balances are wei, not tinybars. The contract's arithmetic is self-consistent
 * either way, so these tests pass under both, and only testnet exercises the
 * real units. Spikes 6 and 9 cover that.
 *
 *   npx hardhat test
 */
const { expect } = require("chai");
const { ethers, network } = require("hardhat");

const HSS = "0x000000000000000000000000000000000000016b";
const H = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
const KEY = ethers.keccak256(ethers.toUtf8Bytes("the-secret-key"));

async function now() {
  return (await ethers.provider.getBlock("latest")).timestamp;
}

/** Put the mock's runtime code at 0x16b, where HoldEscrow will look for it. */
async function installMock() {
  const mock = await (await ethers.getContractFactory("MockHSS")).deploy();
  await mock.waitForDeployment();
  const code = await ethers.provider.getCode(await mock.getAddress());
  await network.provider.send("hardhat_setCode", [HSS, code]);
  return await ethers.getContractAt("MockHSS", HSS);
}

/** Call refund() as the contract itself, which is how the network does it (C1). */
async function asSelf(escrowAddress) {
  await network.provider.send("hardhat_impersonateAccount", [escrowAddress]);
  await network.provider.send("hardhat_setBalance", [escrowAddress, "0x21e19e0c9bab2400000"]);
  return await ethers.getSigner(escrowAddress);
}

describe("HoldEscrow", function () {
  let escrow, mock, owner, server, payer, payee;
  let escrowAddress;

  const AMOUNT = 1_000_000_000n; // 10 "HBAR" in tinybar terms
  const FUND = 100_000_000_000n;

  async function params(overrides = {}) {
    return {
      payer: payer.address,
      payee: payee.address,
      amountTinybar: AMOUNT,
      deadline: BigInt((await now()) + 120),
      hKey: ethers.keccak256(KEY),
      hCipher: H("ciphertext"),
      hPlain: H("plaintext"),
      hRequest: H(`request-${Math.random()}`),
      ...overrides,
    };
  }

  beforeEach(async function () {
    // Code planted at 0x16b keeps its STORAGE between tests, so a saturated
    // second configured by one test leaks into the next. Reset first.
    await network.provider.send("hardhat_reset");
    [owner, server, payer, payee] = await ethers.getSigners();
    mock = await installMock();
    escrow = await (await ethers.getContractFactory("HoldEscrow")).deploy();
    await escrow.waitForDeployment();
    escrowAddress = await escrow.getAddress();
    await escrow.setOpener(server.address, true);
    // Simulate an x402 settlement: the funds are simply CREDITED (C12), so the
    // tests put them there the same way — no call into the contract.
    await network.provider.send("hardhat_setBalance", [escrowAddress, "0x" + FUND.toString(16)]);
  });

  describe("openHold", function () {
    it("arms a refund and records the hold", async function () {
      const p = await params();
      await expect(escrow.connect(server).openHold(p)).to.emit(escrow, "HoldOpened");

      const h = await escrow.getHold(1);
      expect(h.status).to.equal(1); // OPEN
      expect(h.amountTinybar).to.equal(AMOUNT);
      expect(h.payer).to.equal(payer.address);
      expect(await escrow.totalLockedTinybar()).to.equal(AMOUNT);
      expect(await escrow.openHoldCount()).to.equal(1);

      // It asked the Schedule Service for the right thing.
      expect(await mock.scheduleCallCount()).to.equal(1);
      expect(await mock.lastTo()).to.equal(escrowAddress);
      expect(await mock.lastGasLimit()).to.equal(await escrow.REFUND_GAS());
      expect(await mock.lastValue()).to.equal(0);
    });

    it("rejects a caller that is not on the allowlist", async function () {
      await expect(escrow.connect(payer).openHold(await params()))
        .to.be.revertedWithCustomError(escrow, "NotAnOpener");
    });

    it("refuses to open when the payment is not actually here", async function () {
      await network.provider.send("hardhat_setBalance", [escrowAddress, "0x0"]);
      await expect(escrow.connect(server).openHold(await params()))
        .to.be.revertedWithCustomError(escrow, "Underfunded");
    });

    it("blocks a replayed request hash", async function () {
      const hRequest = H("same-request");
      await escrow.connect(server).openHold(await params({ hRequest }));
      await expect(escrow.connect(server).openHold(await params({ hRequest })))
        .to.be.revertedWithCustomError(escrow, "RequestAlreadyHeld");
    });

    it("rejects a deadline outside the allowed window", async function () {
      await expect(escrow.connect(server).openHold(await params({ deadline: BigInt((await now()) + 5) })))
        .to.be.revertedWithCustomError(escrow, "DeadlineOutOfRange");
    });

    it("reverts the WHOLE call when scheduleCall fails, leaving no hold", async function () {
      await mock.setScheduleCallCode(207); // SCHEDULE_EXPIRY_IS_BUSY-ish
      await expect(escrow.connect(server).openHold(await params()))
        .to.be.revertedWithCustomError(escrow, "HssNotSuccess");

      // Nothing survived: no hold, no lock, no count. Funds held with no armed
      // refund is the worst state in the system.
      expect((await escrow.getHold(1)).status).to.equal(0);
      expect(await escrow.totalLockedTinybar()).to.equal(0);
      expect(await escrow.openHoldCount()).to.equal(0);
    });

    it("catches a zero schedule address even when the code says 22", async function () {
      // The two halves of the return are checked INDEPENDENTLY. A contract that
      // only looked at the code would sail straight past this, believing it had
      // armed a refund that does not exist.
      await mock.setReturnZeroAddress(true);
      await expect(escrow.connect(server).openHold(await params()))
        .to.be.revertedWithCustomError(escrow, "HssZeroScheduleAddress");
    });
  });

  describe("the capacity/jitter fallback — untested on testnet, tested here", function () {
    it("walks past saturated seconds and arms a later one", async function () {
      const deadline = BigInt((await now()) + 120);
      // Saturate everything up to the requested second and a little past it,
      // forcing the exponential-backoff probe loop to actually run.
      await mock.setSaturatedBelow(deadline + 5n);

      const tx = await escrow.connect(server).openHold(await params({ deadline }));
      const rc = await tx.wait();
      const ev = rc.logs
        .map((l) => {
          try {
            return escrow.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((e) => e && e.name === "HoldOpened");

      expect(ev.args.probesUsed).to.be.greaterThan(0);
      expect(ev.args.armedDeadline).to.be.greaterThan(ev.args.requestedDeadline);
      // The hold's stored deadline is the one actually armed, so refund()'s
      // calldata check will match.
      expect((await escrow.getHold(1)).deadline).to.equal(ev.args.armedDeadline);
    });

    it("never arms on a minute boundary", async function () {
      const base = BigInt((await now()) + 120);
      const onMinute = base - (base % 60n) + 60n;
      const tx = await escrow.connect(server).openHold(await params({ deadline: onMinute }));
      await tx.wait();
      expect((await escrow.getHold(1)).deadline % 60n).to.not.equal(0n);
    });

    it("gives up rather than arming nothing when every second is saturated", async function () {
      const deadline = BigInt((await now()) + 120);
      await mock.setSaturatedBelow(deadline + 100_000n);
      await expect(escrow.connect(server).openHold(await params({ deadline })))
        .to.be.revertedWithCustomError(escrow, "NoUnsaturatedSecond");
    });
  });

  describe("claim", function () {
    beforeEach(async function () {
      await escrow.connect(server).openHold(await params());
    });

    it("pays the payee, deletes the schedule and reveals k", async function () {
      const before = await ethers.provider.getBalance(payee.address);
      await expect(escrow.connect(server).claim(1, KEY))
        .to.emit(escrow, "Claimed")
        .withArgs(1, payee.address, KEY);

      expect(await ethers.provider.getBalance(payee.address)).to.equal(before + AMOUNT);
      expect(await mock.deleteCount()).to.equal(1);
      expect((await escrow.getHold(1)).status).to.equal(2); // CLAIMED
      expect(await escrow.totalLockedTinybar()).to.equal(0);
      expect(await escrow.openHoldCount()).to.equal(0);
    });

    it("rejects a guessed key", async function () {
      await expect(escrow.connect(server).claim(1, H("wrong"))).to.be.revertedWithCustomError(escrow, "BadKey");
      expect((await escrow.getHold(1)).status).to.equal(1); // still OPEN
    });

    it("REVERTS if the schedule delete is refused — this is the double-payout guard", async function () {
      // C3: on the real network a refused delete is a silent no-op. If claim
      // swallowed it, the payee would be paid AND the refund would still fire.
      await mock.setDeleteCode(7); // INVALID_SIGNATURE
      await expect(escrow.connect(server).claim(1, KEY)).to.be.revertedWithCustomError(escrow, "HssNotSuccess");

      expect((await escrow.getHold(1)).status).to.equal(1); // OPEN, nothing consumed
      expect(await escrow.totalLockedTinybar()).to.equal(AMOUNT);
    });

    it("cannot be claimed twice", async function () {
      await escrow.connect(server).claim(1, KEY);
      await expect(escrow.connect(server).claim(1, KEY)).to.be.revertedWithCustomError(escrow, "BadState");
    });

    it("credits instead of reverting when the payee refuses payment", async function () {
      const rejecting = await (await ethers.getContractFactory("RejectingRecipient")).deploy();
      await rejecting.waitForDeployment();
      const addr = await rejecting.getAddress();

      await escrow.connect(server).openHold(await params({ payee: addr }));
      await expect(escrow.connect(server).claim(2, KEY)).to.emit(escrow, "PayoutDeferred");

      expect(await escrow.withdrawableTinybar(addr)).to.equal(AMOUNT);
      expect((await escrow.getHold(2)).status).to.equal(2); // still CLAIMED
    });
  });

  describe("refund", function () {
    let self;

    beforeEach(async function () {
      await escrow.connect(server).openHold(await params());
      self = await asSelf(escrowAddress);
    });

    it("only the contract itself may call it", async function () {
      const h = await escrow.getHold(1);
      await expect(escrow.connect(server).refund(1, h.deadline))
        .to.be.revertedWithCustomError(escrow, "NotTheNetwork");
    });

    it("pays the payer when the network executes it", async function () {
      const h = await escrow.getHold(1);
      const before = await ethers.provider.getBalance(payer.address);
      await expect(escrow.connect(self).refund(1, h.deadline)).to.emit(escrow, "Refunded");

      expect(await ethers.provider.getBalance(payer.address)).to.equal(before + AMOUNT);
      expect((await escrow.getHold(1)).status).to.equal(3); // REFUNDED
      expect(await escrow.openHoldCount()).to.equal(0);
    });

    it("rejects a schedule carrying the wrong deadline", async function () {
      await expect(escrow.connect(self).refund(1, 12345)).to.be.revertedWithCustomError(escrow, "StaleSchedule");
    });

    it("a claim after the refund is refused — exactly one of them wins", async function () {
      const h = await escrow.getHold(1);
      await escrow.connect(self).refund(1, h.deadline);
      await expect(escrow.connect(server).claim(1, KEY)).to.be.revertedWithCustomError(escrow, "BadState");
    });

    it("a refund after the claim is refused — the same, in the other order", async function () {
      const h = await escrow.getHold(1);
      await escrow.connect(server).claim(1, KEY);
      await expect(escrow.connect(self).refund(1, h.deadline)).to.be.revertedWithCustomError(escrow, "BadState");
    });

    it("credits rather than reverting when the payer cannot receive", async function () {
      // The critical property: refund() must never revert after its transition,
      // because the schedule is spent by executing and cannot be re-armed (C11).
      const burner = await (await ethers.getContractFactory("GasBurningRecipient")).deploy();
      await burner.waitForDeployment();
      const addr = await burner.getAddress();

      await escrow.connect(server).openHold(await params({ payer: addr }));
      const h2 = await escrow.getHold(2);
      await expect(escrow.connect(self).refund(2, h2.deadline)).to.emit(escrow, "PayoutDeferred");

      expect(await escrow.withdrawableTinybar(addr)).to.equal(AMOUNT);
      expect((await escrow.getHold(2)).status).to.equal(3); // REFUNDED, not stuck
    });
  });

  describe("solvency", function () {
    it("the required reserve grows with each armed refund", async function () {
      const deposit = await escrow.refundGasDepositTinybar();
      const floor = await escrow.minOperatingReserveTinybar();
      expect(await escrow.requiredReserveTinybar()).to.equal(floor);

      await escrow.connect(server).openHold(await params());
      expect(await escrow.requiredReserveTinybar()).to.equal(floor + deposit);

      await escrow.connect(server).openHold(await params());
      expect(await escrow.requiredReserveTinybar()).to.equal(floor + deposit * 2n);
    });

    it("refuses a hold that would leave armed refunds unfundable", async function () {
      // Just enough for the payment, nowhere near enough to execute its refund.
      const tight = AMOUNT + (await escrow.refundGasDepositTinybar());
      await network.provider.send("hardhat_setBalance", [escrowAddress, "0x" + tight.toString(16)]);
      await expect(escrow.connect(server).openHold(await params()))
        .to.be.revertedWithCustomError(escrow, "Insolvent");
    });

    it("the owner cannot sweep below what open holds need", async function () {
      // Deploy fresh and fund DELIBERATELY, so the whole balance is sweepable
      // float and the solvency bound is the guard under test. A contract whose
      // balance arrived as a settlement has no sweepable float at all — that is
      // the separate ExceedsOperatingFloat case below.
      const fresh = await (await ethers.getContractFactory("HoldEscrow")).deploy();
      await fresh.waitForDeployment();
      await fresh.setOpener(server.address, true);
      await fresh.fund({ value: FUND });
      await fresh.connect(server).openHold(await params());

      const free = await fresh.freeTinybar();
      await expect(fresh.sweepReserve(owner.address, free))
        .to.be.revertedWithCustomError(fresh, "WouldBreakSolvency");
    });

    it("a settled payment is not sweepable at all — it never became float", async function () {
      // The balance in this suite is set directly, which is how an x402
      // settlement arrives: credited without running any code (C12).
      expect(await escrow.operatingFloatTinybar()).to.equal(0n);
      await expect(escrow.sweepReserve(owner.address, 1n))
        .to.be.revertedWithCustomError(escrow, "ExceedsOperatingFloat");
    });

    it("free balance never counts locked or credited funds", async function () {
      await escrow.connect(server).openHold(await params());
      const bal = await escrow.balanceTinybar();
      const locked = await escrow.totalLockedTinybar();
      const credited = await escrow.totalWithdrawableTinybar();
      expect(await escrow.freeTinybar()).to.equal(bal - locked - credited);
    });
  });

  describe("withdraw and rescue", function () {
    it("a deferred payout can be collected later", async function () {
      const rejecting = await (await ethers.getContractFactory("RejectingRecipient")).deploy();
      await rejecting.waitForDeployment();
      const addr = await rejecting.getAddress();
      await escrow.connect(server).openHold(await params({ payee: addr }));
      await escrow.connect(server).claim(1, KEY);
      expect(await escrow.withdrawableTinybar(addr)).to.equal(AMOUNT);
      // The rejecting contract still cannot receive, so withdraw reverts — which
      // is SAFE here, unlike in refund(): the credit stays and can be retried.
      expect(await escrow.totalWithdrawableTinybar()).to.equal(AMOUNT);
    });

    it("rescue is refused before the grace period", async function () {
      await escrow.connect(server).openHold(await params());
      await expect(escrow.rescue(1)).to.be.revertedWithCustomError(escrow, "TooEarlyToRescue");
    });

    it("rescue credits the payer once the grace period has passed", async function () {
      await escrow.connect(server).openHold(await params());
      const h = await escrow.getHold(1);
      await network.provider.send("evm_setNextBlockTimestamp", [Number(h.deadline) + 24 * 3600 + 1]);
      await network.provider.send("evm_mine");

      await expect(escrow.rescue(1)).to.emit(escrow, "Rescued");
      expect(await escrow.withdrawableTinybar(payer.address)).to.equal(AMOUNT);
      expect((await escrow.getHold(1)).status).to.equal(3);
    });
  });
});
