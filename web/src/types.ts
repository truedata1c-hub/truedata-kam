// Типы ответов API, общие для страниц и диалогов.

export interface Campaign {
  id: string; number: number; title: string; stage: string; cancel_reason: string | null; period_from: string; period_to: string; control_date: string; overdue: boolean;
  network: { id: string; name: string; regions: string[] }; type: { id: string; name: string; period_split: string }; owner: { id: string; name: string };
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
