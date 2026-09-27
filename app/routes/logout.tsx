import type { Route } from "./+types/logout";
import { destroyUserSession } from "~/lib/auth/session.server";

export async function loader({ request }: Route.LoaderArgs) {
  return destroyUserSession(request);
}

export async function action({ request }: Route.ActionArgs) {
  return destroyUserSession(request);
}
