import { BarChart3, BookOpenText, Flag, Link2, ListChecks, MessageSquareText, Settings, Users } from "lucide-react";

export const PROJECT_NAV = [
  { segment: "", label: "Overview", icon: BarChart3 },
  { segment: "prompts", label: "Prompts", icon: MessageSquareText },
  { segment: "competitors", label: "Competitors", icon: Users },
  { segment: "citations", label: "Citations", icon: Link2 },
  { segment: "opportunities", label: "Opportunities", icon: Flag },
  { segment: "actions", label: "Actions", icon: ListChecks },
  { segment: "reports", label: "Reports", icon: BookOpenText },
  { segment: "settings", label: "Settings", icon: Settings },
] as const;
