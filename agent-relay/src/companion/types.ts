export type CompanionMessageRole = "user" | "assistant" | "system_summary";
export type CompanionMessageStatus = "streaming" | "completed" | "interrupted" | "deleted";
export type CompanionOutputMode = "bounded" | "unrestricted";
export type CompanionOutputModeInput = CompanionOutputMode | "raw";

export interface CompanionSession {
  id: string;
  personaId: string;
  title: string;
  storageRoot: string;
  incognito: boolean;
  createdAt: string;
  updatedAt: string;
  lastSummaryMessageId?: string;
}

export interface CompanionMessage {
  id: string;
  sessionId: string;
  role: CompanionMessageRole;
  content: string;
  status: CompanionMessageStatus;
  trusted: boolean;
  memoryEligible: boolean;
  modelName?: string;
  clientName?: string;
  storageRoot: string;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface CompanionSummary {
  id: string;
  sessionId: string;
  sourceMessageStartId: string;
  sourceMessageEndId: string;
  summary: string;
  topics: string[];
  trustLevel: "generated";
  modelName?: string;
  createdAt: string;
}

export interface CompanionStorageStatus {
  storageRoot: string;
  dbPath: string;
  schemaVersion: number;
  writable: boolean;
}

export interface CompanionVectorStatus {
  enabled: false;
  namespace: string;
  reason: string;
}

export interface CompanionSafetyResult {
  content: string;
  rewritten: boolean;
  flags: string[];
  attachmentRisk: "low" | "medium" | "high" | "critical";
  realityAnchored: boolean;
  virtualIdentitySafe: boolean;
  warmEnough: boolean;
  outputMode: CompanionOutputMode;
}

export interface CompanionChatResult {
  session?: CompanionSession;
  userMessage?: CompanionMessage;
  assistantMessage?: CompanionMessage;
  content: string;
  storage: CompanionStorageStatus;
  safety: CompanionSafetyResult;
  summaryStatus: {
    generated: boolean;
    summaryId?: string;
    reason?: string;
  };
  vector: CompanionVectorStatus;
}

export interface CompanionChatInput {
  message?: string;
  sessionId?: string;
  clientName?: string;
  storageRoot?: string;
  personaId?: string;
  incognito?: boolean;
  outputMode?: CompanionOutputModeInput;
}
