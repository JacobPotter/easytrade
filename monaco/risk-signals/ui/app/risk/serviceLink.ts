import { getIntentLink } from "@dynatrace-sdk/navigation";

/** Services app and the intent it declares for opening one service. */
// UNVERIFIED: the intent ID follows the platform naming pattern (e.g. dynatrace.classic.hosts / view-host).
// If it is wrong, the AppShell falls back to the "Open with" dialog instead of opening the Services app.
export const SERVICES_APP_ID = "dynatrace.services";
export const SERVICES_VIEW_INTENT = "view-service";

/** Link that opens the given service entity (SERVICE-…) in the Services app. */
export function serviceLink(serviceId: string): string {
  return getIntentLink({ "dt.entity.service": serviceId }, SERVICES_APP_ID, SERVICES_VIEW_INTENT);
}
