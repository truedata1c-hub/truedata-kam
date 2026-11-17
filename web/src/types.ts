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
