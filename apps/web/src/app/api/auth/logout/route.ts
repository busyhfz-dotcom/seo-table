import { redirectTo } from "../../../../lib/redirect";
import { logout } from "../../../../lib/auth";

/**
 * Logout is a POST so it cannot be triggered by a link or an image, and it
 * redirects rather than returning JSON so the plain HTML form works without
 * client-side JavaScript.
 */
export async function POST() {
  await logout();
  return redirectTo("/login", 303);
}
