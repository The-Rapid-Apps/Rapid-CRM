import { redirect, type LoaderFunctionArgs } from "react-router";
import { prisma } from "~/lib/db.server";
import {
  createSignedBillingUrl,
  requireBillingAccess,
} from "~/lib/billing-access.server";
import { activateSubscription } from "~/lib/flex/subscribe.server";
import { activateStandardSubscription } from "~/lib/standard/subscribe.server";
import { confirmOneTimePurchase } from "~/lib/standard/one-time.server";

/**
 * GET /api/flex/return?sid=<subscriptionId>
 *
 * The Shopify charge-approval return callback (spec §2.6 / §3). Shopify
 * redirects the merchant's browser here after they approve. We confirm the
 * subscription is ACTIVE, activate it locally (recording the subscribed event
 * and collapsing the first period), then send the merchant back to the billing
 * page. NOT API-key authed — it's a browser redirect.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);

  /*
    A one-time purchase comes back under `pid`, not `sid`.

    Two parameters rather than one, because the two are not the same kind of
    thing: an `AppPurchaseOneTime` has no period, no trial and no single-active
    invariant, and confirming one must NOT cancel the subscription the merchant
    is on. A shared parameter would put that mistake one lookup away.
  */
  const pid = url.searchParams.get("pid");
  if (pid) {
    const purchase = await prisma.appOneTimePurchase.findUnique({
      where: { id: pid },
      select: { appInstallId: true },
    });
    if (!purchase) throw new Response("Purchase not found", { status: 404 });
    requireBillingAccess(request, purchase.appInstallId);

    const outcome = await confirmOneTimePurchase(pid);
    const back = new URL(createSignedBillingUrl(purchase.appInstallId).url);
    back.searchParams.set("purchased", outcome.confirmed ? "1" : "0");
    return redirect(back.toString());
  }

  const sid = url.searchParams.get("sid");
  if (!sid) throw new Response("Missing sid or pid", { status: 400 });

  const sub = await prisma.subscription.findUnique({
    where: { id: sid },
    select: { appInstallId: true, plan: { select: { flexBilling: true } } },
  });
  if (!sub) throw new Response("Subscription not found", { status: 404 });
  requireBillingAccess(request, sub.appInstallId);

  /*
    One return URL, both rails, dispatched on the PLAN.

    Shopify is given this URL at create time and will call it whichever rail the
    subscription is on, so the branch has to live here. The two activations are
    genuinely different — flex collapses the first period and posts its own first
    charge, standard verifies against Shopify and mirrors the dates Shopify
    states — but they take the SAME per-install lock, which is what keeps
    "exactly one active subscription" true even if a merchant approves a plan on
    each rail at once.
  */
  const result = sub.plan.flexBilling
    ? await activateSubscription(sid)
    : await activateStandardSubscription(sid);
  const destination = new URL(createSignedBillingUrl(sub.appInstallId).url);
  destination.searchParams.set("activated", result.activated ? "1" : "0");
  return redirect(destination.toString());
}
