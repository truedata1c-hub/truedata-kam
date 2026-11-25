// Типы ответов API, общие для страниц и диалогов.

export interface StageDocRef { id: string; file_name: string; kind: string; mime: string; at: string; version: number | null }
export interface Campaign {
  confirmation: StageDocRef | null; final_terms: StageDocRef | null;
  id: string; number: number; title: string; stage: string; cancel_reason: string | null; period_from: string; period_to: string; control_date: string; overdue: boolean;
  network: { id: string; name: string; regions: string[] }; type: { id: string; name: string; period_split: string }; owner: { id: string | null; name: string };
  legal_entities: { id: string; inn: string; name: string; active: boolean; selected: boolean }[];
  events: { id: string; kind: string; from_stage: string | null; to_stage: string | null; comment: string | null; payload: any; at: string; actor_name: string | null }[];
  actions: string[];
}

export interface Role { id: string; name: string; description: string; permissions: string[]; scope: string; archived: boolean; users: number }

export interface User {
  id: string; email: string; display_name: string; disabled: boolean; active: boolean; last_login_at: string | null; must_change_password: boolean;
  has_password: boolean; sso: boolean; role_ids: string[]; brand_ids: string[]; me: boolean;
  manager: { id: string; manager_id: string; name: string; from: string } | null;
  assignments: { id: string; network_id: string; network_name: string; from: string; to: string | null }[];
}

export interface Network {
  id: string; name: string; regions: string[]; group_id: string | null; group_name: string | null; archived: boolean; campaigns: number;
  legal_entities: { id: string; inn: string; name: string; active: boolean }[];
  kams: { user_id: string; name: string }[];
}

export interface Period { key: string; label: string; from: string; to: string }
export interface PriorView { plan_investment: number | null; fact_investment: number | null; plan_turnover: number | null; fact_turnover: number | null; plan_roi: number | null; fact_roi: number | null; execution_pct: number | null }
export interface Money { investment: number; turnover: number }
export interface VersionBrand {
  brand_id: string | null; name: string; note: string | null; cells: Record<string, Money>;
  total: Money & { roi: number | null }; previous: Money | null; prior: PriorView | null; period_prior: Record<string, PriorView | null> | null; highlights: string[];
}
export interface Version {
  number: number; latest: number; created_at: string; author: string; periods: Period[]; justification: string; comment: string;
  documents: { id: string; kind: string; file_name: string; archived_at: string | null }[];
  brands: VersionBrand[];
  totals: Money & { roi: number | null; previous: Money | null; prior: PriorView | null; highlights: string[] };
  prior_label: string; brand_limited: boolean;
  thresholds: { investment_growth_pct: number; execution_below_pct: number; roi_below_prior: boolean };
}
export interface VersionSummary { number: number; created_at: string; author: string; investment: number; turnover: number; roi: number | null; comment: string; documents: number; brands: number }
export interface Doc {
  id: string; kind: string; file_name: string; mime: string; size: number; stage: string; comment: string; uploaded_at: string; uploaded_by_name: string;
  archived_at: string | null; archive_reason: string | null; archived_by_name: string | null; versions: number[]; previewable: boolean;
}
export interface Draft {
  periods: Period[]; base_number: number | null; cells: { brand_id: string; period_key: string; investment: number; turnover: number }[];
  justification: string; prior: Record<string, PriorView | null>; prior_label: string;
  thresholds: { investment_growth_pct: number; execution_below_pct: number; roi_below_prior: boolean };
}

export interface RouteStepView {
  position: number; title: string; assignee_rule: string; condition_text: string; deadline_days: number;
  included: boolean; skip_reason: string | null; candidates: { id: string; name: string }[]; assign_note: string | null; error: string | null;
}
export interface ApprovalStep {
  id: string; position: number; title: string; assignee_rule: string; condition_text: string; status: 'WAITING' | 'ACTIVE' | 'APPROVED' | 'REJECTED' | 'SKIPPED' | 'CANCELLED';
  skip_reason: string | null; assign_note: string | null; deadline_days: number; activated_at: string | null; due_date: string | null; overdue: boolean;
  decided_at: string | null; decision_comment: string | null; decided_by_name: string | null; decided_for_name: string | null;
  candidate_users: { id: string; name: string }[]; deputies: { user: string; deputy: string; to: string }[];
}
export interface ApprovalRound {
  id: string; round: number; status: 'IN_PROGRESS' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN' | 'SUPERSEDED' | 'CANCELLED'; template_name: string;
  submitted_at: string; finished_at: string | null; submit_comment: string; submitted_by_name: string; version: number;
  investment: number; turnover: number; tolerance_investment_pct: number; tolerance_turnover_pct: number; steps: ApprovalStep[];
}
export interface ApprovalView {
  rounds: ApprovalRound[]; current: ApprovalRound | null; my_decision: { step_id: string; for_user: string | null } | null; can_withdraw: boolean;
  preview: { template: { id: string; name: string; rule: string | null; tolerance_investment_pct: number; tolerance_turnover_pct: number } | null; steps: RouteStepView[]; version: number | null; problems: string[] } | null;
}
export type Assignee = { kind: 'MANAGER'; level: number } | { kind: 'ROLE'; role_id: string; scoped: boolean } | { kind: 'USER'; user_id: string };
export type Condition = { kind: 'INVESTMENT_GTE'; amount: number } | { kind: 'GROWTH_GTE'; pct: number } | { kind: 'ROI_BELOW_PRIOR' } | { kind: 'TYPE_IN' | 'NETWORK_IN' | 'GROUP_IN' | 'BRAND_IN'; ids: string[] };
export interface StepDef { title: string; assignee: Assignee; conditions: Condition[]; deadline_days: number; assignee_text?: string; conditions_text?: string[] }
export interface RouteTemplate { id: string; name: string; description: string; is_default: boolean; steps: StepDef[]; tolerance_investment_pct: number; tolerance_turnover_pct: number; revision: number; updated_at: string; in_progress: number }
export interface RouteRule { id?: string; priority?: number; template_id: string; campaign_type_id: string | null; network_group_id: string | null; type_name?: string | null; group_name?: string | null }
