interface OrganizationBranding {
  name: string;
  logo?: string;
  icons: Array<{ id: string; name: string; image: string }>;
}

/** Web-only Relay has no native enrollment bridge, so there is never
 * organization branding to apply. The hook stays so callers compile unchanged. */
export function useOrganizationBranding(): OrganizationBranding | null {
  return null;
}
