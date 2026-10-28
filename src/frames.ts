// Frame types for the AutoWonder executor WebSocket protocol.
// Source of truth: community edition 1.0.0
//   docs/scheduler-executor-protocol.md (§5 信号/帧目录) and
//   websocket/WsDispatchTransport.java#buildFrame (fields beyond the doc).

export type FrameType =
  | 'TASK_DISPATCH' | 'TASK_ACK' | 'TASK_PROGRESS' | 'TASK_RESULT'
  | 'TASK_HANDOFF' | 'HEARTBEAT' | 'ARTIFACT_UPLOADED';

/** Capabilities a client may declare on HEARTBEAT (protocolFeatures). */
export type ProtocolFeature =
  | 'TASK_PACKAGE_SIGNATURE_V1'
  | 'DEBUG_LOG_V1'
  | 'dispatch_inventory_v1';

/** Executor dispatch inventory — carried inside HEARTBEAT (dispatch_inventory_v1). */
export interface ExecutorInventory {
  /** 1..50; the server validates the range and closes the session on violation. */
  readonly maxConcurrentDispatches: number;
  /** Required with dispatch_inventory_v1. */
  readonly dispatchInventoryReady: boolean;
  /** Dispatches currently executing here (≤50; must be a subset of owned). */
  readonly runningDispatchIds: readonly number[];
  /** All dispatches this executor still owns (≤1000; superset of running). */
  readonly ownedDispatchIds: readonly number[];
  /** Conversation turns in flight (≤50). */
  readonly runningConversationTurnIds: readonly number[];
  /** Optional; only "OWNED_DISPATCH_LIMIT_EXCEEDED" has defined semantics. */
  readonly dispatchInventoryError?: string;
}

/** DOWN: server → executor. One per dispatch entering DISPATCHED. */
export interface TaskDispatchFrame {
  readonly type: 'TASK_DISPATCH';
  readonly dispatchId: number;
  readonly executorId: number;
  readonly tenantId: number;
  readonly workitemId: number;
  readonly agentId: number;
  readonly agentVersionId: number;
  readonly sdlcStepId: number;
  readonly attempt: number;
  /** OSS presigned GET, ~600s validity. */
  readonly downloadUrl: string;
  readonly md5: string;
  readonly size: number;
  readonly packageId: string;
  /** Whole-archive digest, "sha256:<hex>". Server sends it; hard verification is Phase 2. */
  readonly checksum?: string;
  readonly checksumAlgorithm?: 'sha256';
  readonly checksumScope?: 'zip_archive';
  /** Package signature block — only when client declared TASK_PACKAGE_SIGNATURE_V1. */
  readonly issuer?: string;
  readonly signatureRef?: string;
  readonly signature?: string;
  readonly signatureAlgorithm?: string;
  readonly signaturePublicKey?: string;
  readonly expiresAt?: string;
  /** Policy flags frozen at packaging time. */
  readonly allowCommit: boolean;
  readonly allowPush: boolean;
  readonly allowNetwork: boolean;
  /** Ready-made HTTP paths (auth = ?token=<executorToken>), relative to server base. */
  readonly packageRefreshPath: string;
  readonly artifactUploadPath: string;
  readonly checkpointUploadPath: string;
  readonly memorySnapshotPath: string;
  readonly memoryChangesPath: string;
  readonly memoryMutationPath: string;
  readonly memoryRecallPath: string;
  readonly memoryStartingRevisions: Record<string, unknown>;
  /** Per-dispatch MCP bearer token (awdispatch_…, TTL 24h) for POST /api/mcp. */
  readonly dispatchMcpToken: string;
  /** Only present when negotiated via HEARTBEAT protocolFeatures. */
  readonly debugLog?: { readonly enabled: boolean; readonly maxBytes: number };
  /** Resume block — FLAT wire fields (not a nested object), present when this
   *  dispatch resumes a dead/interrupted predecessor. */
  readonly resumeMode?: string;
  readonly resumeSessionBehavior?: string;
  readonly resumeFromDispatchId?: number;
  readonly resumeProvider?: string;
  readonly resumeSessionId?: string;
  readonly resumeCheckpointUrl?: string;
  readonly resumeCheckpointSha256?: string;
  readonly resumeCheckpointSeq?: number;
  readonly resumeCheckpointCandidates?: readonly ResumeCheckpointCandidate[];
}

/** Checkpoint pointer carried on TASK_DISPATCH.resumeCheckpointCandidates. */
export interface ResumeCheckpointCandidate {
  readonly checkpointSeq: number;
  readonly sha256?: string;
  readonly provider?: string;
  readonly providerSessionId?: string;
  readonly sizeBytes?: number;
}

/** UP: executor → server. ACK must precede download. */
export interface TaskAckFrame {
  readonly type: 'TASK_ACK';
  readonly dispatchId: number;
}

/**
 * UP: executor → server. First frame transitions ACKED→RUNNING; later frames
 * are persisted as runtime events. Optional structured companion fields
 * (stepOrder/stepId/stepName/message/error/detailJson) may ride in `log`.
 */
export interface TaskProgressFrame {
  readonly type: 'TASK_PROGRESS';
  readonly dispatchId: number;
  readonly resultSummary: string;
}

/** UP: terminal for a dispatch; drives SdlcDriver next-step decision.
 * V2 (resultProtocolVersion: 2) adds a client-generated resultId (UUID) plus the
 * COMPLETION-checkpoint pin (checkpointSeq + checkpointSha256) — the server only
 * accepts V2 SUCCESS results that pin a matching COMPLETION checkpoint, and
 * replays idempotently on (dispatchId, resultId) + payload hash. */
export interface TaskResultFrame {
  readonly type: 'TASK_RESULT';
  readonly dispatchId: number;
  readonly success: boolean;
  readonly resultSummary: string;
  readonly error?: string;
  /** UUID v4 string; required for V2. */
  readonly resultId?: string;
  readonly resultProtocolVersion?: number;
  /** From the COMPLETION checkpoint receipt; required for V2 success. */
  readonly checkpointSeq?: number;
  readonly checkpointSha256?: string;
  readonly debugLog?: {
    readonly status: 'UPLOADED' | 'FAILED';
    readonly channel?: 'DIRECT' | 'RELAY';
    readonly sizeBytes?: number;
    readonly sha256?: string;
    readonly truncated?: boolean;
    readonly error?: string | null;
  };
}

/** UP: after TASK_RESULT when handoff-proposal.json exists. */
export interface TaskHandoffFrame {
  readonly type: 'TASK_HANDOFF';
  readonly dispatchId: number;
  readonly workitemId: number;
  /** Role/name string from roster.json — NOT a numeric user id. */
  readonly to: string;
  readonly toType: 'AGENT' | 'HUMAN';
  readonly nextRole: string;
  readonly reason: string;
}

/** UP: keep-alive, ~30s period. Refreshes exec:online / exec:route TTL (90s).
 * With dispatch_inventory_v1 the server renews active leases for the reported
 * running dispatches and may trigger a runtime reconcile — long-running steps
 * MUST report their dispatch ids here or risk being reclaimed as dead. */
export interface HeartbeatFrame {
  readonly type: 'HEARTBEAT';
  readonly protocolFeatures?: readonly ProtocolFeature[];
  /** Executor version string, surfaced in platform executor diagnostics. */
  readonly version?: string;
  /** Current engine model label, surfaced in platform executor diagnostics. */
  readonly model?: string;
  readonly maxConcurrentDispatches?: number;
  readonly dispatchInventoryReady?: boolean;
  readonly runningDispatchIds?: readonly number[];
  readonly ownedDispatchIds?: readonly number[];
  readonly runningConversationTurnIds?: readonly number[];
  readonly dispatchInventoryError?: string;
}

/** Phase 2 — not emitted by the MVP. */
export interface ArtifactUploadedFrame {
  readonly type: 'ARTIFACT_UPLOADED';
  readonly dispatchId: number;
  readonly workitemId: number;
  readonly name: string;
  readonly artifactType: 'DELIVERABLE' | 'HANDOFF_PROPOSAL' | 'LEARNING_DELTA' | string;
  readonly ossRef: string;
  readonly size: number;
  readonly metaJson?: string;
}

/** Reply to TASK_HANDOFF: status AGENT_DISPATCHED/HUMAN_ASSIGNED/REJECTED… + downstreamDispatchId. */
export interface TaskHandoffResultFrame {
  readonly type: 'TASK_HANDOFF_RESULT';
  readonly dispatchId: number;
  readonly workitemId?: number;
  readonly status?: string;
  readonly downstreamDispatchId?: number;
  readonly targetType?: string;
  readonly targetRef?: string | number;
  readonly reasonCode?: string;
  readonly message?: string;
}

/** DOWN control: stop a running dispatch, checkpoint it, and reply TASK_PAUSED. */
export interface TaskPauseFrame {
  readonly type: 'TASK_PAUSE';
  readonly dispatchId: number;
  readonly executorId?: number;
}

/** Reply to TASK_RESULT: whether the durable result was accepted. */
export interface TaskResultAckFrame {
  readonly type: 'TASK_RESULT_ACK';
  readonly dispatchId: number;
  readonly accepted?: boolean;
}

export type ServerFrame = TaskDispatchFrame | TaskHandoffResultFrame | TaskResultAckFrame | TaskPauseFrame;
export type ClientFrame =
  | TaskAckFrame | TaskProgressFrame | TaskResultFrame
  | TaskHandoffFrame | HeartbeatFrame | ArtifactUploadedFrame
  | TaskPausedFrame | TaskPauseFailedFrame;

/** UP: completed a TASK_PAUSE — pins the final checkpoint for later resume. */
export interface TaskPausedFrame {
  readonly type: 'TASK_PAUSED';
  readonly dispatchId: number;
  readonly checkpointSeq: number;
  readonly checkpointSha256: string;
}

/** UP: cannot satisfy a TASK_PAUSE (dispatch not running here). */
export interface TaskPauseFailedFrame {
  readonly type: 'TASK_PAUSE_FAILED';
  readonly dispatchId: number;
  readonly error: string;
}

export function decodeServerFrame(raw: string): ServerFrame | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return undefined; }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const frame = parsed as { type?: unknown };
  if (frame.type !== 'TASK_DISPATCH' && frame.type !== 'TASK_HANDOFF_RESULT'
    && frame.type !== 'TASK_RESULT_ACK' && frame.type !== 'TASK_PAUSE') return undefined;
  return parsed as ServerFrame;
}
