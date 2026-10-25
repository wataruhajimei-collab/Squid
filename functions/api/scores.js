import { handleApiRequest } from "../../worker.js";

export async function onRequest(context) {
  return handleApiRequest(context.request, context.env);
}
