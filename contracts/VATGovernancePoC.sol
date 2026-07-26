// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// ============================================================================
// VATGovernancePoC — Bounded-Core reconstruction (Step 2C, per Spec V3.1)
// ----------------------------------------------------------------------------
// Two levels:
//   Invoice level:  None -> Entitled -> Issued -> Received -> Acknowledged
//   Period level:   None -> Open -> ReportedPositionRecorded -> {branch} -> Closed
//
// Payment/settlement/reconciliation are REMOVED from the invoice level and
// modeled at the seller output-VAT PERIOD level. NTPN/BPN is state-treasury
// payment evidence, NOT buyer->seller commercial settlement.
//
// The contract records commitments to EXTERNALLY determined results
// (period position, settlement completion). It does NOT calculate VAT,
// does NOT determine legal liability, does NOT execute refunds.
//
// Exceptions are ROUTED via a generic governed handoff (markScopeUnderReview /
// recordExternalResolutionReference), not solved inside the core.
//
// Application-level roles only. This is NOT network-level permissioning.
//
// NOTE: sourceEventTimeCommitment is an external commitment; artifactRecordedAt
// is the EVM block timestamp and is NOT the authoritative legal time.
// ============================================================================

contract VATGovernancePoC {
    // ---------------------------------------------------------------- enums
    enum InvoiceStatus { None, Entitled, Issued, Received, Acknowledged }

    enum PeriodStatus {
        None,
        Open,
        ReportedPositionRecorded,
        SettlementEvidenceRecorded,       // payable branch
        SettlementCompletionRecorded,     // payable branch
        SupervisoryReviewOutcomeRecorded, // payable/nil branch
        ExternalResolutionRequired,       // overpaid branch
        ExternalResolutionReferenced,     // overpaid branch
        Closed
    }

    enum PeriodPositionType { Payable, Nil, Overpaid }
    enum SettlementEvidenceType { DirectPaymentBPN, BookTransferEvidence }
    enum SettlementCompletionStatus { Incomplete, Complete }
    enum SupervisoryReviewOutcome { ClearedForClosure, ExceptionRequired }
    enum EvidenceScope { Invoice, Period, Settlement, Exception }

    // ---------------------------------------------------------------- roles
    // Application-level roles (NOT network permissioning). One account may hold
    // several roles in a stated test configuration.
    bytes32 constant TAX_AUTHORITY_ROLE            = keccak256("TAX_AUTHORITY_ROLE");
    bytes32 constant SELLER_ROLE                   = keccak256("SELLER_ROLE");
    bytes32 constant BUYER_ROLE                    = keccak256("BUYER_ROLE");
    bytes32 constant TAX_SYSTEM_RECORDER_ROLE      = keccak256("TAX_SYSTEM_RECORDER_ROLE");
    bytes32 constant PERIOD_POSTER_ROLE            = keccak256("PERIOD_POSTER_ROLE");
    bytes32 constant TAX_RETURN_RECORDER_ROLE      = keccak256("TAX_RETURN_RECORDER_ROLE");
    bytes32 constant SETTLEMENT_EVIDENCE_RECORDER_ROLE = keccak256("SETTLEMENT_EVIDENCE_RECORDER_ROLE");
    bytes32 constant SUPERVISORY_REVIEWER_ROLE     = keccak256("SUPERVISORY_REVIEWER_ROLE");

    address public admin;
    mapping(bytes32 => mapping(address => bool)) public hasRole;

    // ---------------------------------------------------------------- structs
    struct InvoiceRecord {
        InvoiceStatus status;
        bytes32 entitlementHash;
        bytes32 invoiceHash;
        bytes32 periodKey;   // 0x0 until posted
        bool posted;
    }

    struct SettlementRecord {
        SettlementEvidenceType evidenceType;
        bytes32 evidenceRefHash;
        bytes32 amountCommitmentHash;      // NOT raw amount (confidentiality)
        bytes32 sourceEventTimeCommitment; // external commitment
        uint256 artifactRecordedAt;        // EVM time, not legal time
    }

    struct PeriodRecord {
        PeriodStatus status;
        PeriodPositionType positionType;
        bool positionRecorded;
        bytes32 positionEvidenceHash;
        bytes32 invoiceSetCommitmentHash;  // frozen set commitment (P4)
        uint256 committedInvoiceCount;
        bytes32 noActivityEvidenceHash;    // nil with no posted invoice (P3)
        uint256 postedInvoiceCount;
        SettlementCompletionStatus latestCompletion;
        bool completionEverRecorded;
        bool underReview;                  // exception flag (P6)
        bytes32 externalResolutionHash;
        bool externalResolutionRecorded;
    }

    mapping(bytes32 => InvoiceRecord) private invoices;   // invoiceIdHash => record
    mapping(bytes32 => PeriodRecord)  private periods;    // periodKey => record
    mapping(bytes32 => SettlementRecord[]) private settlements; // periodKey => append-only

    // ---------------------------------------------------------------- events
    event RoleGranted(bytes32 indexed role, address indexed account);
    event EntitlementValidated(bytes32 indexed invoiceId, address indexed actor, bytes32 entitlementHash);
    event InvoiceIssued(bytes32 indexed invoiceId, address indexed actor, bytes32 invoiceHash);
    event SystemReceiptRecorded(bytes32 indexed invoiceId, address indexed actor);
    event BuyerAcknowledged(bytes32 indexed invoiceId, address indexed actor, bytes32 ackHash);
    event PeriodOpened(bytes32 indexed periodKey, address indexed actor);
    event InvoicePostedToPeriod(bytes32 indexed invoiceId, bytes32 indexed periodKey, address indexed actor);
    event ReportedPositionRecorded(bytes32 indexed periodKey, PeriodPositionType positionType, address indexed actor);
    event SettlementEvidenceRecorded(bytes32 indexed periodKey, SettlementEvidenceType evidenceType, address indexed actor);
    event SettlementCompletionRecorded(bytes32 indexed periodKey, SettlementCompletionStatus status, address indexed actor);
    event SupervisoryReviewOutcomeRecorded(bytes32 indexed periodKey, SupervisoryReviewOutcome outcome, address indexed actor);
    event ExternalResolutionReferenceRecorded(bytes32 indexed periodKey, address indexed actor, bytes32 resolutionHash);
    event SupervisoryPeriodClosed(bytes32 indexed periodKey, address indexed actor);
    event ScopeMarkedUnderReview(uint8 indexed scopeType, bytes32 indexed refHash, address indexed actor, bytes32 reasonHash);
    event EvidenceRequested(uint8 indexed scope, bytes32 indexed refHash, address indexed actor, bytes32 scopeHash);
    event EvidenceSubmitted(uint8 indexed scope, bytes32 indexed refHash, address indexed actor, bytes32 evidenceHash);

    // ---------------------------------------------------------------- modifiers
    modifier onlyRole(bytes32 role) {
        require(hasRole[role][msg.sender], "REJECTED_ROLE_REQUIRED");
        _;
    }

    constructor() {
        admin = msg.sender;
    }

    function grantRole(bytes32 role, address account) external {
        require(msg.sender == admin, "REJECTED_ADMIN_REQUIRED");
        hasRole[role][account] = true;
        emit RoleGranted(role, account);
    }

    // ================================================= INVOICE LEVEL
    function validateEntitlement(bytes32 invoiceId, bytes32 entitlementHash)
        external onlyRole(TAX_AUTHORITY_ROLE)
    {
        require(invoices[invoiceId].status == InvoiceStatus.None, "BLOCKED_INVOICE_ALREADY_STARTED");
        invoices[invoiceId].status = InvoiceStatus.Entitled;
        invoices[invoiceId].entitlementHash = entitlementHash;
        emit EntitlementValidated(invoiceId, msg.sender, entitlementHash);
    }

    function issueInvoice(bytes32 invoiceId, bytes32 invoiceHash)
        external onlyRole(SELLER_ROLE)
    {
        require(invoices[invoiceId].status == InvoiceStatus.Entitled, "BLOCKED_ENTITLEMENT_REQUIRED");
        invoices[invoiceId].status = InvoiceStatus.Issued;
        invoices[invoiceId].invoiceHash = invoiceHash;
        emit InvoiceIssued(invoiceId, msg.sender, invoiceHash);
    }

    function recordSystemReceipt(bytes32 invoiceId)
        external onlyRole(TAX_SYSTEM_RECORDER_ROLE)
    {
        require(invoices[invoiceId].status == InvoiceStatus.Issued, "BLOCKED_INVOICE_ISSUANCE_REQUIRED");
        invoices[invoiceId].status = InvoiceStatus.Received;
        emit SystemReceiptRecorded(invoiceId, msg.sender);
    }

    function acknowledgeBuyer(bytes32 invoiceId, bytes32 ackHash)
        external onlyRole(BUYER_ROLE)
    {
        require(invoices[invoiceId].status == InvoiceStatus.Received, "BLOCKED_SYSTEM_RECEIPT_REQUIRED");
        invoices[invoiceId].status = InvoiceStatus.Acknowledged;
        emit BuyerAcknowledged(invoiceId, msg.sender, ackHash);
    }

    // ================================================= PERIOD: open + posting
    function openPeriod(bytes32 periodKey)
        external onlyRole(PERIOD_POSTER_ROLE)
    {
        require(periods[periodKey].status == PeriodStatus.None, "BLOCKED_PERIOD_ALREADY_OPEN");
        periods[periodKey].status = PeriodStatus.Open;
        emit PeriodOpened(periodKey, msg.sender);
    }

    // P1: period must be Open. P2: invoice Received/Acknowledged, not already
    // posted, invoice+period not under review. No "cancelled" test (excluded).
    function postInvoiceToPeriod(bytes32 invoiceId, bytes32 periodKey)
        external onlyRole(PERIOD_POSTER_ROLE)
    {
        InvoiceRecord storage inv = invoices[invoiceId];
        PeriodRecord storage per = periods[periodKey];

        require(per.status == PeriodStatus.Open, "BLOCKED_PERIOD_NOT_OPEN");           // P1
        require(!per.underReview, "BLOCKED_PERIOD_UNDER_REVIEW");
        require(
            inv.status == InvoiceStatus.Received || inv.status == InvoiceStatus.Acknowledged,
            "BLOCKED_INVOICE_NOT_READY_FOR_POSTING"                                     // P2
        );
        require(!inv.posted, "BLOCKED_INVOICE_ALREADY_POSTED");                         // one-time link

        inv.posted = true;
        inv.periodKey = periodKey;
        per.postedInvoiceCount += 1;
        emit InvoicePostedToPeriod(invoiceId, periodKey, msg.sender);
    }

    // ================================================= PERIOD: position
    // P3: nil may use noActivityEvidenceHash without a posted invoice.
    // P4: freeze the invoice set via commitment + count at position time.
    function recordReportedPeriodPosition(
        bytes32 periodKey,
        PeriodPositionType positionType,
        bytes32 positionEvidenceHash,
        bytes32 invoiceSetCommitmentHash,
        uint256 committedInvoiceCount,
        bytes32 noActivityEvidenceHash
    ) external onlyRole(TAX_RETURN_RECORDER_ROLE) {
        PeriodRecord storage per = periods[periodKey];
        require(per.status == PeriodStatus.Open, "BLOCKED_PERIOD_NOT_OPEN");
        require(!per.underReview, "BLOCKED_PERIOD_UNDER_REVIEW");

        if (positionType == PeriodPositionType.Nil) {
            // exactly one evidence path: posted-set nil OR no-activity commitment
            bool hasPostedSet = (per.postedInvoiceCount > 0 && invoiceSetCommitmentHash != bytes32(0));
            bool hasNoActivity = (noActivityEvidenceHash != bytes32(0));
            require(hasPostedSet != hasNoActivity, "BLOCKED_NIL_EXACTLY_ONE_EVIDENCE_PATH"); // P3
            per.noActivityEvidenceHash = noActivityEvidenceHash;
        } else {
            // Payable / Overpaid require a posted set commitment
            require(per.postedInvoiceCount > 0, "BLOCKED_NO_POSTED_INVOICE");
            require(invoiceSetCommitmentHash != bytes32(0), "BLOCKED_SET_COMMITMENT_REQUIRED");
        }
        require(positionEvidenceHash != bytes32(0), "BLOCKED_POSITION_EVIDENCE_REQUIRED");

        per.positionType = positionType;
        per.positionRecorded = true;
        per.positionEvidenceHash = positionEvidenceHash;
        per.invoiceSetCommitmentHash = invoiceSetCommitmentHash;
        per.committedInvoiceCount = committedInvoiceCount;
        per.status = PeriodStatus.ReportedPositionRecorded;
        emit ReportedPositionRecorded(periodKey, positionType, msg.sender);
    }

    // ================================================= PAYABLE branch
    function recordSettlementEvidence(
        bytes32 periodKey,
        SettlementEvidenceType evidenceType,
        bytes32 evidenceRefHash,
        bytes32 amountCommitmentHash,
        bytes32 sourceEventTimeCommitment
    ) external onlyRole(SETTLEMENT_EVIDENCE_RECORDER_ROLE) {
        PeriodRecord storage per = periods[periodKey];
        require(!per.underReview, "BLOCKED_PERIOD_UNDER_REVIEW");
        require(per.positionRecorded && per.positionType == PeriodPositionType.Payable,
            "BLOCKED_PAYABLE_POSITION_REQUIRED");                                       // payable only
        require(
            per.status == PeriodStatus.ReportedPositionRecorded ||
            per.status == PeriodStatus.SettlementEvidenceRecorded ||
            per.status == PeriodStatus.SettlementCompletionRecorded,
            "BLOCKED_INVALID_STATE_FOR_SETTLEMENT_EVIDENCE"
        );
        require(sourceEventTimeCommitment != bytes32(0), "BLOCKED_SOURCE_TIME_COMMITMENT_REQUIRED"); // P7 B6a

        settlements[periodKey].push(SettlementRecord({
            evidenceType: evidenceType,
            evidenceRefHash: evidenceRefHash,
            amountCommitmentHash: amountCommitmentHash,
            sourceEventTimeCommitment: sourceEventTimeCommitment,
            artifactRecordedAt: block.timestamp
        }));
        per.status = PeriodStatus.SettlementEvidenceRecorded;
        emit SettlementEvidenceRecorded(periodKey, evidenceType, msg.sender);
    }

    // P5: completion is an external decision; Incomplete blocks closure.
    function recordSettlementCompletionDecision(
        bytes32 periodKey,
        SettlementCompletionStatus status,
        bytes32 /*completionEvidenceHash*/
    ) external onlyRole(SETTLEMENT_EVIDENCE_RECORDER_ROLE) {
        PeriodRecord storage per = periods[periodKey];
        require(!per.underReview, "BLOCKED_PERIOD_UNDER_REVIEW");
        require(settlements[periodKey].length > 0, "BLOCKED_SETTLEMENT_EVIDENCE_REQUIRED");
        per.latestCompletion = status;            // append-only supersede (P5)
        per.completionEverRecorded = true;
        per.status = PeriodStatus.SettlementCompletionRecorded;
        emit SettlementCompletionRecorded(periodKey, status, msg.sender);
    }

    // ================================================= review outcome (payable/nil)
    function recordSupervisoryReviewOutcome(
        bytes32 periodKey,
        SupervisoryReviewOutcome outcome
    ) external onlyRole(SUPERVISORY_REVIEWER_ROLE) {
        PeriodRecord storage per = periods[periodKey];
        require(!per.underReview, "BLOCKED_PERIOD_UNDER_REVIEW");
        require(per.positionRecorded, "BLOCKED_POSITION_REQUIRED");

        if (per.positionType == PeriodPositionType.Payable) {
            require(per.completionEverRecorded &&
                per.latestCompletion == SettlementCompletionStatus.Complete,
                "BLOCKED_COMPLETE_SETTLEMENT_REQUIRED");                                // P5
        } else if (per.positionType == PeriodPositionType.Nil) {
            require(per.status == PeriodStatus.ReportedPositionRecorded,
                "BLOCKED_INVALID_STATE_FOR_NIL_REVIEW");
        } else {
            revert("BLOCKED_OVERPAID_USES_EXTERNAL_RESOLUTION");
        }

        per.status = PeriodStatus.SupervisoryReviewOutcomeRecorded;
        emit SupervisoryReviewOutcomeRecorded(periodKey, outcome, msg.sender);
        // ExceptionRequired does not advance; reviewer must route via handoff.
        if (outcome == SupervisoryReviewOutcome.ExceptionRequired) {
            per.underReview = true;
        }
    }

    // ================================================= OVERPAID branch
    function requireOverpaidResolution(bytes32 periodKey)
        external onlyRole(SUPERVISORY_REVIEWER_ROLE)
    {
        PeriodRecord storage per = periods[periodKey];
        require(per.positionRecorded && per.positionType == PeriodPositionType.Overpaid,
            "BLOCKED_OVERPAID_POSITION_REQUIRED");
        require(per.status == PeriodStatus.ReportedPositionRecorded, "BLOCKED_INVALID_STATE");
        per.status = PeriodStatus.ExternalResolutionRequired;
    }

    // ================================================= exception handoff (P6)
    function markScopeUnderReview(uint8 scopeType, bytes32 refHash, bytes32 reasonHash)
        external onlyRole(SUPERVISORY_REVIEWER_ROLE)
    {
        // refHash is a periodKey when scopeType == Period/Settlement/Exception
        PeriodRecord storage per = periods[refHash];
        require(!per.underReview, "BLOCKED_ALREADY_UNDER_REVIEW");
        per.underReview = true;
        emit ScopeMarkedUnderReview(scopeType, refHash, msg.sender, reasonHash);
    }

    // Clears the flag only; does NOT skip prerequisites or auto-advance (P6).
    // For overpaid, this reference satisfies the branch prerequisite for closure.
    function recordExternalResolutionReference(uint8 /*scopeType*/, bytes32 refHash, bytes32 resolutionHash)
        external onlyRole(SUPERVISORY_REVIEWER_ROLE)
    {
        PeriodRecord storage per = periods[refHash];
        per.externalResolutionHash = resolutionHash;
        per.externalResolutionRecorded = true;
        per.underReview = false;
        if (per.status == PeriodStatus.ExternalResolutionRequired) {
            per.status = PeriodStatus.ExternalResolutionReferenced;
        }
        emit ExternalResolutionReferenceRecorded(refHash, msg.sender, resolutionHash);
    }

    // ================================================= closure
    function closeSupervisoryPeriod(bytes32 periodKey)
        external onlyRole(SUPERVISORY_REVIEWER_ROLE)
    {
        PeriodRecord storage per = periods[periodKey];
        require(!per.underReview, "BLOCKED_PERIOD_UNDER_REVIEW");

        bool payableOrNilReady =
            per.status == PeriodStatus.SupervisoryReviewOutcomeRecorded;
        bool overpaidReady =
            per.positionType == PeriodPositionType.Overpaid &&
            per.status == PeriodStatus.ExternalResolutionReferenced &&
            per.externalResolutionRecorded;

        require(payableOrNilReady || overpaidReady, "BLOCKED_CLOSURE_PREREQUISITE_NOT_MET");
        per.status = PeriodStatus.Closed;
        emit SupervisoryPeriodClosed(periodKey, msg.sender);
    }

    // ================================================= scoped evidence handling
    function requestEvidence(EvidenceScope scope, bytes32 refHash, bytes32 scopeHash)
        external onlyRole(TAX_AUTHORITY_ROLE)
    {
        emit EvidenceRequested(uint8(scope), refHash, msg.sender, scopeHash);
    }

    function submitEvidence(EvidenceScope scope, bytes32 refHash, bytes32 evidenceHash)
        external onlyRole(SELLER_ROLE)
    {
        emit EvidenceSubmitted(uint8(scope), refHash, msg.sender, evidenceHash);
    }

    // ================================================= views
    function getInvoiceStatus(bytes32 invoiceId) external view returns (InvoiceStatus) {
        return invoices[invoiceId].status;
    }
    function getPeriodStatus(bytes32 periodKey) external view returns (PeriodStatus) {
        return periods[periodKey].status;
    }
    function getPeriodUnderReview(bytes32 periodKey) external view returns (bool) {
        return periods[periodKey].underReview;
    }
    function getSettlementCount(bytes32 periodKey) external view returns (uint256) {
        return settlements[periodKey].length;
    }
}
