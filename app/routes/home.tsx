import { redirect } from "react-router";

// The platform root simply lands on the management dashboard.
export function loader() {
  return redirect("/app");
}
