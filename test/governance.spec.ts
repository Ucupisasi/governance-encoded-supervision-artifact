import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { getAddress, stringToHex, keccak256, toHex } from "viem";

const { viem, networkHelpers } = await network.create();

// Role identifiers must match keccak256("ROLE_NAME") in the contract.
const ROLES = {
  TAX_AUTHORITY: keccak256(stringToHex("TAX_AUTHORITY_ROLE")),
  SELLER: keccak256(stringToHex("SELLER_ROLE")),
  BUYER: keccak256(stringToHex("BUYER_ROLE")),
  TAX_SYSTEM: keccak256(stringToHex("TAX_SYSTEM_RECORDER_ROLE")),
  PERIOD_POSTER: keccak256(stringToHex("PERIOD_POSTER_ROLE")),
  RETURN_RECORDER: keccak256(stringToHex("TAX_RETURN_RECORDER_ROLE")),
  SETTLEMENT_RECORDER: keccak256(stringToHex("SETTLEMENT_EVIDENCE_RECORDER_ROLE")),
  REVIEWER: keccak256(stringToHex("SUPERVISORY_REVIEWER_ROLE")),
};

// PeriodPositionType
const POS = { Payable: 0, Nil: 1, Overpaid: 2 };
// SettlementEvidenceType
const EVID = { DirectPaymentBPN: 0, BookTransferEvidence: 1 };
// SettlementCompletionStatus
const COMPLETION = { Incomplete: 0, Complete: 1 };
// SupervisoryReviewOutcome
const OUTCOME = { ClearedForClosure: 0, ExceptionRequired: 1 };

function id(v: string) { return stringToHex(v, { size: 32 }); }
function hash(v: string) { return keccak256(stringToHex(v)); }

describe("VAT governance-encoded supervisory logic (bounded-core V3.1)", function () {
  // --- fixture: deploy + grant a stated role configuration -----------------
  // Config note: distinct wallets per role (separation-of-duties config).
  async function deployFixture() {
    const wallets = await viem.getWalletClients();
    const [admin, taxAuthority, seller, buyer, taxSystem, poster, returnRec, settleRec, reviewer] = wallets;

    const vat = await viem.deployContract("VATGovernancePoC", []);

    async function grant(role: `0x${string}`, who: any) {
      await vat.write.grantRole([role, getAddress(who.account.address)], { account: admin.account });
    }
    await grant(ROLES.TAX_AUTHORITY, taxAuthority);
    await grant(ROLES.SELLER, seller);
    await grant(ROLES.BUYER, buyer);
    await grant(ROLES.TAX_SYSTEM, taxSystem);
    await grant(ROLES.PERIOD_POSTER, poster);
    await grant(ROLES.RETURN_RECORDER, returnRec);
    await grant(ROLES.SETTLEMENT_RECORDER, settleRec);
    await grant(ROLES.REVIEWER, reviewer);

    const publicClient = await viem.getPublicClient();
    return { vat, publicClient, admin, taxAuthority, seller, buyer, taxSystem, poster, returnRec, settleRec, reviewer };
  }

  // helper: drive an invoice to Acknowledged
  async function toAcknowledged(ctx: any, code: string) {
    const { vat, taxAuthority, seller, taxSystem, buyer } = ctx;
    await vat.write.validateEntitlement([id(code), hash("ENT")], { account: taxAuthority.account });
    await vat.write.issueInvoice([id(code), hash("INV")], { account: seller.account });
    await vat.write.recordSystemReceipt([id(code)], { account: taxSystem.account });
    await vat.write.acknowledgeBuyer([id(code), hash("ACK")], { account: buyer.account });
  }

  // ========================================================= BASELINE GTL
  it("GTL-S1 accepted: valid invoice progression to Acknowledged", async function () {
    const ctx = await networkHelpers.loadFixture(deployFixture);
    await toAcknowledged(ctx, "S1");
    const status = await ctx.vat.read.getInvoiceStatus([id("S1")]);
    assert.equal(Number(status), 4); // Acknowledged
  });

  it("GTL-S2 accepted: posting does NOT require buyer acknowledgment (Received is enough)", async function () {
    const ctx = await networkHelpers.loadFixture(deployFixture);
    const { vat, taxAuthority, seller, taxSystem, poster } = ctx;
    // only up to Received (no acknowledgment)
    await vat.write.validateEntitlement([id("S2"), hash("ENT")], { account: taxAuthority.account });
    await vat.write.issueInvoice([id("S2"), hash("INV")], { account: seller.account });
    await vat.write.recordSystemReceipt([id("S2")], { account: taxSystem.account });
    await vat.write.openPeriod([id("P-S2")], { account: poster.account });
    // posting before acknowledgment succeeds (ack is not the gate)
    await viem.assertions.emitWithArgs(
      vat.write.postInvoiceToPeriod([id("S2"), id("P-S2")], { account: poster.account }),
      vat, "InvoicePostedToPeriod",
      [id("S2"), id("P-S2"), getAddress(poster.account.address)]
    );
  });

  it("GTL-S3 rejected: unauthorized posting (non-poster) is rejected", async function () {
    const ctx = await networkHelpers.loadFixture(deployFixture);
    const { vat, taxAuthority, seller, taxSystem, poster, buyer } = ctx;
    await toAcknowledged(ctx, "S3");
    await vat.write.openPeriod([id("P-S3")], { account: poster.account });
    await viem.assertions.revertWith(
      vat.write.postInvoiceToPeriod([id("S3"), id("P-S3")], { account: buyer.account }),
      "REJECTED_ROLE_REQUIRED"
    );
  });

  it("GTL-S4 accepted: payable position recorded with posted set + closure via complete settlement", async function () {
    const ctx = await networkHelpers.loadFixture(deployFixture);
    const { vat, poster, returnRec, settleRec, reviewer } = ctx;
    await toAcknowledged(ctx, "S4");
    await vat.write.openPeriod([id("P-S4")], { account: poster.account });
    await vat.write.postInvoiceToPeriod([id("S4"), id("P-S4")], { account: poster.account });
    await vat.write.recordReportedPeriodPosition(
      [id("P-S4"), POS.Payable, hash("POSEV"), hash("SETCOMMIT"), 1n, toHex(0, { size: 32 })],
      { account: returnRec.account }
    );
    await vat.write.recordSettlementEvidence(
      [id("P-S4"), EVID.DirectPaymentBPN, hash("BPN"), hash("AMT"), hash("SRCTIME")],
      { account: settleRec.account }
    );
    await vat.write.recordSettlementCompletionDecision(
      [id("P-S4"), COMPLETION.Complete, hash("COMPEV")],
      { account: settleRec.account }
    );
    await vat.write.recordSupervisoryReviewOutcome(
      [id("P-S4"), OUTCOME.ClearedForClosure],
      { account: reviewer.account }
    );
    await vat.write.closeSupervisoryPeriod([id("P-S4")], { account: reviewer.account });
    const st = await vat.read.getPeriodStatus([id("P-S4")]);
    assert.equal(Number(st), 8); // Closed
  });

  it("GTL-S5 accepted: nil period closes via no-activity evidence with no posted invoice", async function () {
    const ctx = await networkHelpers.loadFixture(deployFixture);
    const { vat, poster, returnRec, reviewer } = ctx;
    await vat.write.openPeriod([id("P-S5")], { account: poster.account });
    await vat.write.recordReportedPeriodPosition(
      [id("P-S5"), POS.Nil, hash("POSEV"), toHex(0, { size: 32 }), 0n, hash("NOACT")],
      { account: returnRec.account }
    );
    await vat.write.recordSupervisoryReviewOutcome(
      [id("P-S5"), OUTCOME.ClearedForClosure],
      { account: reviewer.account }
    );
    await vat.write.closeSupervisoryPeriod([id("P-S5")], { account: reviewer.account });
    const st = await vat.read.getPeriodStatus([id("P-S5")]);
    assert.equal(Number(st), 8);
  });

  it("GTL-S6 blocked: settlement evidence on a nil position is blocked (payable only)", async function () {
    const ctx = await networkHelpers.loadFixture(deployFixture);
    const { vat, poster, returnRec, settleRec } = ctx;
    await vat.write.openPeriod([id("P-S6")], { account: poster.account });
    await vat.write.recordReportedPeriodPosition(
      [id("P-S6"), POS.Nil, hash("POSEV"), toHex(0, { size: 32 }), 0n, hash("NOACT")],
      { account: returnRec.account }
    );
    await viem.assertions.revertWith(
      vat.write.recordSettlementEvidence(
        [id("P-S6"), EVID.DirectPaymentBPN, hash("BPN"), hash("AMT"), hash("SRCTIME")],
        { account: settleRec.account }
      ),
      "BLOCKED_PAYABLE_POSITION_REQUIRED"
    );
  });

  it("GTL-S7 recorded: scoped evidence request and submission", async function () {
    const ctx = await networkHelpers.loadFixture(deployFixture);
    const { vat, taxAuthority, seller } = ctx;
    await toAcknowledged(ctx, "S7");
    await viem.assertions.emitWithArgs(
      vat.write.requestEvidence([1, id("P-S7"), hash("SCOPE")], { account: taxAuthority.account }),
      vat, "EvidenceRequested",
      [1, id("P-S7"), getAddress(taxAuthority.account.address), hash("SCOPE")]
    );
    await viem.assertions.emitWithArgs(
      vat.write.submitEvidence([1, id("P-S7"), hash("EVID")], { account: seller.account }),
      vat, "EvidenceSubmitted",
      [1, id("P-S7"), getAddress(seller.account.address), hash("EVID")]
    );
  });

  it("GTL-S8 rejected: settlement evidence by unauthorized actor", async function () {
    const ctx = await networkHelpers.loadFixture(deployFixture);
    const { vat, poster, returnRec, seller } = ctx;
    await toAcknowledged(ctx, "S8");
    await vat.write.openPeriod([id("P-S8")], { account: poster.account });
    await vat.write.postInvoiceToPeriod([id("S8"), id("P-S8")], { account: poster.account });
    await vat.write.recordReportedPeriodPosition(
      [id("P-S8"), POS.Payable, hash("POSEV"), hash("SETCOMMIT"), 1n, toHex(0, { size: 32 })],
      { account: returnRec.account }
    );
    await viem.assertions.revertWith(
      vat.write.recordSettlementEvidence(
        [id("P-S8"), EVID.DirectPaymentBPN, hash("BPN"), hash("AMT"), hash("SRCTIME")],
        { account: seller.account }
      ),
      "REJECTED_ROLE_REQUIRED"
    );
  });

  // ========================================================= BOUNDARY (represented)
  // Each scenario tests a represented boundary by blocking ordinary progression or,
  // where explicitly tested, completing a governed handoff; the artifact does not solve
  // the underlying institutional process.

  it("B1 boundary: second posting of same invoice to another period is blocked (one-time link)", async function () {
    const ctx = await networkHelpers.loadFixture(deployFixture);
    const { vat, poster } = ctx;
    await toAcknowledged(ctx, "B1");
    await vat.write.openPeriod([id("P-B1a")], { account: poster.account });
    await vat.write.openPeriod([id("P-B1b")], { account: poster.account });
    await vat.write.postInvoiceToPeriod([id("B1"), id("P-B1a")], { account: poster.account });
    // second assignment attempt rejected (separate tx; no routing in same tx — P7)
    await viem.assertions.revertWith(
      vat.write.postInvoiceToPeriod([id("B1"), id("P-B1b")], { account: poster.account }),
      "BLOCKED_INVOICE_ALREADY_POSTED"
    );
  });

  it("B2 boundary: payable period with evidence but no completion decision cannot advance to review", async function () {
    const ctx = await networkHelpers.loadFixture(deployFixture);
    const { vat, poster, returnRec, settleRec, reviewer } = ctx;
    await toAcknowledged(ctx, "B2");
    await vat.write.openPeriod([id("P-B2")], { account: poster.account });
    await vat.write.postInvoiceToPeriod([id("B2"), id("P-B2")], { account: poster.account });
    await vat.write.recordReportedPeriodPosition(
      [id("P-B2"), POS.Payable, hash("POSEV"), hash("SETCOMMIT"), 1n, toHex(0, { size: 32 })],
      { account: returnRec.account }
    );
    await vat.write.recordSettlementEvidence(
      [id("P-B2"), EVID.DirectPaymentBPN, hash("BPN"), hash("AMT"), hash("SRCTIME")],
      { account: settleRec.account }
    );
    // no completion decision -> review outcome blocked
    await viem.assertions.revertWith(
      vat.write.recordSupervisoryReviewOutcome([id("P-B2"), OUTCOME.ClearedForClosure], { account: reviewer.account }),
      "BLOCKED_COMPLETE_SETTLEMENT_REQUIRED"
    );
  });

  it("B3 boundary: overpaid period without external-resolution reference cannot close", async function () {
    const ctx = await networkHelpers.loadFixture(deployFixture);
    const { vat, poster, returnRec, reviewer } = ctx;
    await toAcknowledged(ctx, "B3");
    await vat.write.openPeriod([id("P-B3")], { account: poster.account });
    await vat.write.postInvoiceToPeriod([id("B3"), id("P-B3")], { account: poster.account });
    await vat.write.recordReportedPeriodPosition(
      [id("P-B3"), POS.Overpaid, hash("POSEV"), hash("SETCOMMIT"), 1n, toHex(0, { size: 32 })],
      { account: returnRec.account }
    );
    await vat.write.requireOverpaidResolution([id("P-B3")], { account: reviewer.account });
    // closure attempted before external resolution reference -> blocked
    await viem.assertions.revertWith(
      vat.write.closeSupervisoryPeriod([id("P-B3")], { account: reviewer.account }),
      "BLOCKED_CLOSURE_PREREQUISITE_NOT_MET"
    );
    // after recording external resolution reference -> closes
    await vat.write.recordExternalResolutionReference([2, id("P-B3"), hash("RESOLUTION")], { account: reviewer.account });
    await vat.write.closeSupervisoryPeriod([id("P-B3")], { account: reviewer.account });
    const st = await vat.read.getPeriodStatus([id("P-B3")]);
    assert.equal(Number(st), 8);
  });

  it("B4 boundary: closure blocked while scope is under review", async function () {
    const ctx = await networkHelpers.loadFixture(deployFixture);
    const { vat, poster, returnRec, settleRec, reviewer } = ctx;
    await toAcknowledged(ctx, "B4");
    await vat.write.openPeriod([id("P-B4")], { account: poster.account });
    await vat.write.postInvoiceToPeriod([id("B4"), id("P-B4")], { account: poster.account });
    await vat.write.recordReportedPeriodPosition(
      [id("P-B4"), POS.Payable, hash("POSEV"), hash("SETCOMMIT"), 1n, toHex(0, { size: 32 })],
      { account: returnRec.account }
    );
    await vat.write.recordSettlementEvidence(
      [id("P-B4"), EVID.DirectPaymentBPN, hash("BPN"), hash("AMT"), hash("SRCTIME")],
      { account: settleRec.account }
    );
    await vat.write.recordSettlementCompletionDecision([id("P-B4"), COMPLETION.Complete, hash("COMPEV")], { account: settleRec.account });
    await vat.write.recordSupervisoryReviewOutcome([id("P-B4"), OUTCOME.ClearedForClosure], { account: reviewer.account });
    // route under review
    await vat.write.markScopeUnderReview([3, id("P-B4"), hash("REASON")], { account: reviewer.account });
    await viem.assertions.revertWith(
      vat.write.closeSupervisoryPeriod([id("P-B4")], { account: reviewer.account }),
      "BLOCKED_PERIOD_UNDER_REVIEW"
    );
  });

  it("B5 boundary: posting to a period that is not Open is blocked (late invoice not appended)", async function () {
    const ctx = await networkHelpers.loadFixture(deployFixture);
    const { vat, poster, returnRec } = ctx;
    await toAcknowledged(ctx, "B5");
    await toAcknowledged(ctx, "B5late");
    await vat.write.openPeriod([id("P-B5")], { account: poster.account });
    await vat.write.postInvoiceToPeriod([id("B5"), id("P-B5")], { account: poster.account });
    // position recorded -> period no longer Open
    await vat.write.recordReportedPeriodPosition(
      [id("P-B5"), POS.Payable, hash("POSEV"), hash("SETCOMMIT"), 1n, toHex(0, { size: 32 })],
      { account: returnRec.account }
    );
    // late invoice cannot be silently appended (P1)
    await viem.assertions.revertWith(
      vat.write.postInvoiceToPeriod([id("B5late"), id("P-B5")], { account: poster.account }),
      "BLOCKED_PERIOD_NOT_OPEN"
    );
  });

  it("B6a boundary: settlement evidence with zero source-time commitment is blocked", async function () {
    const ctx = await networkHelpers.loadFixture(deployFixture);
    const { vat, poster, returnRec, settleRec } = ctx;
    await toAcknowledged(ctx, "B6");
    await vat.write.openPeriod([id("P-B6")], { account: poster.account });
    await vat.write.postInvoiceToPeriod([id("B6"), id("P-B6")], { account: poster.account });
    await vat.write.recordReportedPeriodPosition(
      [id("P-B6"), POS.Payable, hash("POSEV"), hash("SETCOMMIT"), 1n, toHex(0, { size: 32 })],
      { account: returnRec.account }
    );
    await viem.assertions.revertWith(
      vat.write.recordSettlementEvidence(
        [id("P-B6"), EVID.DirectPaymentBPN, hash("BPN"), hash("AMT"), toHex(0, { size: 32 })],
        { account: settleRec.account }
      ),
      "BLOCKED_SOURCE_TIME_COMMITMENT_REQUIRED"
    );
    // B6b (semantic inconsistency of a NON-zero committed time) is NOT autonomously
    // detectable by the contract; that case is routed via markScopeUnderReview by an
    // authorized reviewer. The contract only guarantees commitment presence, not truth.
  });

  // ========================================================= POSITIVE-PATH SEMANTICS
  // T15–T17 prove that the artifact does more than block: it represents a governed
  // exception handoff, a governed overpaid exit, and an Incomplete->Complete
  // progression. These verify APPROVED V3.1 semantics; they add no new feature.

  // T15 — Exception handoff end-to-end.
  // Asserts: (1) underReview set true; (2) ordinary progression blocked while under
  // review with exact revert; (3) external-resolution reference stored; (4) underReview
  // cleared to false; (5) main status NOT auto-advanced by clearing; (6) the ordinary
  // prerequisite still governs the next transition.
  it("T15 handoff: mark under review -> block -> record resolution -> flag cleared -> prerequisites still govern", async function () {
    const ctx = await networkHelpers.loadFixture(deployFixture);
    const { vat, poster, returnRec, settleRec, reviewer } = ctx;
    await toAcknowledged(ctx, "T15");
    await vat.write.openPeriod([id("P-T15")], { account: poster.account });
    await vat.write.postInvoiceToPeriod([id("T15"), id("P-T15")], { account: poster.account });
    await vat.write.recordReportedPeriodPosition(
      [id("P-T15"), POS.Payable, hash("POSEV"), hash("SETCOMMIT"), 1n, toHex(0, { size: 32 })],
      { account: returnRec.account }
    );

    // (1) mark under review -> flag true
    await vat.write.markScopeUnderReview([3, id("P-T15"), hash("REASON")], { account: reviewer.account });
    let underReview = await vat.read.getPeriodUnderReview([id("P-T15")]);
    assert.equal(underReview, true, "underReview should be true after markScopeUnderReview");

    // (2) ordinary progression blocked while under review (exact revert)
    await viem.assertions.revertWith(
      vat.write.recordSettlementEvidence(
        [id("P-T15"), EVID.DirectPaymentBPN, hash("BPN"), hash("AMT"), hash("SRCTIME")],
        { account: settleRec.account }
      ),
      "BLOCKED_PERIOD_UNDER_REVIEW"
    );

    // (3)+(4) record external-resolution reference -> flag cleared
    await vat.write.recordExternalResolutionReference([3, id("P-T15"), hash("RESOLUTION")], { account: reviewer.account });
    underReview = await vat.read.getPeriodUnderReview([id("P-T15")]);
    assert.equal(underReview, false, "underReview should be cleared to false");

    // (5) main status NOT auto-advanced: for a payable period, clearing review did not
    // move status past ReportedPositionRecorded (2). Closing still blocked because the
    // ordinary payable prerequisites (settlement evidence + complete decision + review
    // outcome) were never satisfied.
    const st = await vat.read.getPeriodStatus([id("P-T15")]);
    assert.equal(Number(st), 2, "status must remain ReportedPositionRecorded (not auto-advanced)");

    // (6) ordinary prerequisite still governs: closure remains blocked.
    await viem.assertions.revertWith(
      vat.write.closeSupervisoryPeriod([id("P-T15")], { account: reviewer.account }),
      "BLOCKED_CLOSURE_PREREQUISITE_NOT_MET"
    );

    // and after satisfying the ordinary prerequisites, progression proceeds normally
    await vat.write.recordSettlementEvidence(
      [id("P-T15"), EVID.DirectPaymentBPN, hash("BPN"), hash("AMT"), hash("SRCTIME")],
      { account: settleRec.account }
    );
    await vat.write.recordSettlementCompletionDecision([id("P-T15"), COMPLETION.Complete, hash("COMPEV")], { account: settleRec.account });
    await vat.write.recordSupervisoryReviewOutcome([id("P-T15"), OUTCOME.ClearedForClosure], { account: reviewer.account });
    await vat.write.closeSupervisoryPeriod([id("P-T15")], { account: reviewer.account });
    const finalSt = await vat.read.getPeriodStatus([id("P-T15")]);
    assert.equal(Number(finalSt), 8, "period should close after ordinary prerequisites satisfied");
  });

  // T16 — Positive overpaid path (governed exit, NOT refund execution).
  // Asserts: (1) overpaid position recorded; (2) closure before external-resolution
  // reference blocked; (3) external-resolution reference recorded; (4) closure then
  // succeeds per V3.1. Does NOT add a supervisory-review stage the contract does not require.
  it("T16 overpaid: recorded -> closure blocked -> external resolution referenced -> closes (no refund executed)", async function () {
    const ctx = await networkHelpers.loadFixture(deployFixture);
    const { vat, poster, returnRec, reviewer } = ctx;
    await toAcknowledged(ctx, "T16");
    await vat.write.openPeriod([id("P-T16")], { account: poster.account });
    await vat.write.postInvoiceToPeriod([id("T16"), id("P-T16")], { account: poster.account });
    // (1) overpaid position
    await vat.write.recordReportedPeriodPosition(
      [id("P-T16"), POS.Overpaid, hash("POSEV"), hash("SETCOMMIT"), 1n, toHex(0, { size: 32 })],
      { account: returnRec.account }
    );
    await vat.write.requireOverpaidResolution([id("P-T16")], { account: reviewer.account });

    // (2) closure before external-resolution reference is blocked
    await viem.assertions.revertWith(
      vat.write.closeSupervisoryPeriod([id("P-T16")], { account: reviewer.account }),
      "BLOCKED_CLOSURE_PREREQUISITE_NOT_MET"
    );

    // (3) external-resolution reference recorded (this is a REFERENCE to an external
    // resolution; the artifact does NOT execute refund/compensation)
    await vat.write.recordExternalResolutionReference([2, id("P-T16"), hash("REFUND_REF")], { account: reviewer.account });

    // (4) closure now succeeds via the overpaid branch prerequisite
    await vat.write.closeSupervisoryPeriod([id("P-T16")], { account: reviewer.account });
    const st = await vat.read.getPeriodStatus([id("P-T16")]);
    assert.equal(Number(st), 8, "overpaid period closes after external resolution referenced");
  });

  // T17 — Incomplete -> Complete settlement decision.
  // Asserts: (1) settlement evidence recorded; (2) Incomplete decision recorded;
  // (3) review/closure blocked while latest = Incomplete; (4) Complete decision recorded;
  // (5) review + closure proceed; (6) BOTH decisions traceable via the EVENT LOG
  // (the contract stores only latestCompletion; history lives in append-only events).
  it("T17 completion: Incomplete blocks -> Complete allows; both decisions traceable via event log", async function () {
    const ctx = await networkHelpers.loadFixture(deployFixture);
    const { vat, publicClient } = ctx as any;
    const { poster, returnRec, settleRec, reviewer } = ctx;
    await toAcknowledged(ctx, "T17");
    await vat.write.openPeriod([id("P-T17")], { account: poster.account });
    await vat.write.postInvoiceToPeriod([id("T17"), id("P-T17")], { account: poster.account });
    await vat.write.recordReportedPeriodPosition(
      [id("P-T17"), POS.Payable, hash("POSEV"), hash("SETCOMMIT"), 1n, toHex(0, { size: 32 })],
      { account: returnRec.account }
    );
    // (1) settlement evidence
    await vat.write.recordSettlementEvidence(
      [id("P-T17"), EVID.DirectPaymentBPN, hash("BPN"), hash("AMT"), hash("SRCTIME")],
      { account: settleRec.account }
    );
    // (2) Incomplete decision
    await vat.write.recordSettlementCompletionDecision([id("P-T17"), COMPLETION.Incomplete, hash("COMPEV1")], { account: settleRec.account });

    // (3) review blocked while latest = Incomplete
    await viem.assertions.revertWith(
      vat.write.recordSupervisoryReviewOutcome([id("P-T17"), OUTCOME.ClearedForClosure], { account: reviewer.account }),
      "BLOCKED_COMPLETE_SETTLEMENT_REQUIRED"
    );

    // (4) Complete decision recorded (supersedes latest; storage keeps only latest)
    await vat.write.recordSettlementCompletionDecision([id("P-T17"), COMPLETION.Complete, hash("COMPEV2")], { account: settleRec.account });

    // (5) review + closure now proceed
    await vat.write.recordSupervisoryReviewOutcome([id("P-T17"), OUTCOME.ClearedForClosure], { account: reviewer.account });
    await vat.write.closeSupervisoryPeriod([id("P-T17")], { account: reviewer.account });
    assert.equal(Number(await vat.read.getPeriodStatus([id("P-T17")])), 8, "period closes after Complete decision");

    // (6) BOTH decisions traceable via EVENT LOG (not storage). The contract stores
    // only latestCompletion; the Incomplete->Complete history is provable only through
    // the append-only SettlementCompletionRecorded events. We read them from the chain.
    const logs = await publicClient.getContractEvents({
      address: vat.address,
      abi: vat.abi,
      eventName: "SettlementCompletionRecorded",
      fromBlock: 0n,
      toBlock: "latest",
    });
    const statuses = logs
      .filter((l: any) => l.args.periodKey === id("P-T17"))
      .map((l: any) => Number(l.args.status));
    assert.deepEqual(statuses, [COMPLETION.Incomplete, COMPLETION.Complete],
      "event log must show Incomplete then Complete (history preserved in logs, not storage)");
  });

  // ========================================================= COVERAGE-TARGETED SEMANTICS
  // T18–T19 cover two claim-relevant branches identified by the final Node 24
  // coverage run. They add no new contract feature and do not alter V3.1 scope.

  // T18 — Overpaid periods must not enter the ordinary supervisory-review path.
  // Asserts: exact revert, unchanged period status, and no review flag mutation.
  it("T18 overpaid review path: ordinary supervisory review is rejected and state remains unchanged", async function () {
    const ctx = await networkHelpers.loadFixture(deployFixture);
    const { vat, poster, returnRec, reviewer } = ctx;

    await toAcknowledged(ctx, "T18");
    await vat.write.openPeriod([id("P-T18")], { account: poster.account });
    await vat.write.postInvoiceToPeriod([id("T18"), id("P-T18")], { account: poster.account });
    await vat.write.recordReportedPeriodPosition(
      [id("P-T18"), POS.Overpaid, hash("POSEV"), hash("SETCOMMIT"), 1n, toHex(0, { size: 32 })],
      { account: returnRec.account }
    );

    const statusBefore = await vat.read.getPeriodStatus([id("P-T18")]);
    const reviewBefore = await vat.read.getPeriodUnderReview([id("P-T18")]);
    assert.equal(Number(statusBefore), 2, "overpaid period should remain ReportedPositionRecorded before review attempt");
    assert.equal(reviewBefore, false, "overpaid period should not be under review before rejected call");

    await viem.assertions.revertWith(
      vat.write.recordSupervisoryReviewOutcome(
        [id("P-T18"), OUTCOME.ClearedForClosure],
        { account: reviewer.account }
      ),
      "BLOCKED_OVERPAID_USES_EXTERNAL_RESOLUTION"
    );

    const statusAfter = await vat.read.getPeriodStatus([id("P-T18")]);
    const reviewAfter = await vat.read.getPeriodUnderReview([id("P-T18")]);
    assert.equal(Number(statusAfter), Number(statusBefore), "reverted review attempt must not change period status");
    assert.equal(reviewAfter, reviewBefore, "reverted review attempt must not change underReview");
  });

  // T19 — ExceptionRequired activates the governed handoff from a valid payable
  // review path. Asserts: review flag set, closure blocked, resolution clears the
  // flag without changing the main status, and closure succeeds only afterward.
  it("T19 review outcome handoff: ExceptionRequired activates review, resolution clears it, and closure then proceeds", async function () {
    const ctx = await networkHelpers.loadFixture(deployFixture);
    const { vat, poster, returnRec, settleRec, reviewer } = ctx;

    await toAcknowledged(ctx, "T19");
    await vat.write.openPeriod([id("P-T19")], { account: poster.account });
    await vat.write.postInvoiceToPeriod([id("T19"), id("P-T19")], { account: poster.account });
    await vat.write.recordReportedPeriodPosition(
      [id("P-T19"), POS.Payable, hash("POSEV"), hash("SETCOMMIT"), 1n, toHex(0, { size: 32 })],
      { account: returnRec.account }
    );
    await vat.write.recordSettlementEvidence(
      [id("P-T19"), EVID.DirectPaymentBPN, hash("BPN"), hash("AMT"), hash("SRCTIME")],
      { account: settleRec.account }
    );
    await vat.write.recordSettlementCompletionDecision(
      [id("P-T19"), COMPLETION.Complete, hash("COMPEV")],
      { account: settleRec.account }
    );

    await vat.write.recordSupervisoryReviewOutcome(
      [id("P-T19"), OUTCOME.ExceptionRequired],
      { account: reviewer.account }
    );

    const statusAfterOutcome = await vat.read.getPeriodStatus([id("P-T19")]);
    const underReviewAfterOutcome = await vat.read.getPeriodUnderReview([id("P-T19")]);
    assert.equal(Number(statusAfterOutcome), 5, "ExceptionRequired must record SupervisoryReviewOutcomeRecorded status");
    assert.equal(underReviewAfterOutcome, true, "ExceptionRequired must activate underReview");

    await viem.assertions.revertWith(
      vat.write.closeSupervisoryPeriod([id("P-T19")], { account: reviewer.account }),
      "BLOCKED_PERIOD_UNDER_REVIEW"
    );

    await vat.write.recordExternalResolutionReference(
      [3, id("P-T19"), hash("RESOLUTION")],
      { account: reviewer.account }
    );

    const statusAfterResolution = await vat.read.getPeriodStatus([id("P-T19")]);
    const underReviewAfterResolution = await vat.read.getPeriodUnderReview([id("P-T19")]);
    assert.equal(Number(statusAfterResolution), Number(statusAfterOutcome),
      "external-resolution reference must not auto-advance the main period status");
    assert.equal(underReviewAfterResolution, false,
      "external-resolution reference must clear underReview");

    await vat.write.closeSupervisoryPeriod([id("P-T19")], { account: reviewer.account });
    const finalStatus = await vat.read.getPeriodStatus([id("P-T19")]);
    assert.equal(Number(finalStatus), 8, "period should close only after the governed review flag is cleared");
  });

});
