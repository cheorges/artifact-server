/**
 * A loopback stand-in for Microsoft Entra's token endpoint and the three
 * Microsoft Graph calls the group directory makes (decision 0034). It serves
 * in-memory groups, records every request, and can be told to fail.
 */
import {createServer, type IncomingMessage, type Server, type ServerResponse} from "node:http";

import {z} from "zod";

const assignedAddressSchema = z.object({port: z.number().int().positive()});

/** One group the stub directory holds. */
export interface StubGraphGroup {
  readonly displayName: string;
  readonly id: string;
  readonly mail: string | null;
  /** Subjects (object ids) that are transitive members. */
  readonly members: readonly string[];
  readonly visibility: string | null;
}

/** One request the stub received. */
export interface StubGraphRequest {
  readonly authorization: string | null;
  readonly body: string;
  readonly consistencyLevel: string | null;
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
}

/** How the stub answers Graph calls until told otherwise. */
export interface StubGraphBehavior {
  /** Answer every Graph call with this body instead of a real one. */
  body: string | null;
  /** Wait this long before answering a Graph call. */
  delayMilliseconds: number;
  /** Members returned per page of `transitiveMemberOf`. */
  pageSize: number;
  /** Point the next page of `transitiveMemberOf` at this origin instead of the stub. */
  nextLinkOrigin: string | null;
  /** Answer the next Graph call with 401, once. */
  rejectTokenOnce: boolean;
  /** The `Retry-After` header sent with a `status` answer. */
  retryAfter: string | null;
  /** Answer every Graph call with this status instead of 200. */
  status: number | null;
}

/** A running stub. */
export interface StubGraphServer {
  readonly behavior: StubGraphBehavior;
  readonly clientSecret: string;
  readonly groups: StubGraphGroup[];
  readonly origin: string;
  readonly requests: StubGraphRequest[];
  /** The access tokens issued so far, newest last. */
  readonly tokens: string[];
  stop(): Promise<void>;
  readonly tenantId: string;
}

/** Start the stub on a free loopback port. */
export async function startStubGraphServer(): Promise<StubGraphServer> {
  const tenantId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const clientSecret = "stub-graph-client-secret";
  const groups: StubGraphGroup[] = [];
  const requests: StubGraphRequest[] = [];
  const tokens: string[] = [];
  const behavior: StubGraphBehavior = {
    body: null,
    delayMilliseconds: 0,
    nextLinkOrigin: null,
    pageSize: 999,
    rejectTokenOnce: false,
    retryAfter: null,
    status: null,
  };
  let origin = "";
  const server: Server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      response.writeHead(500).end("{}");
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", origin);
    const body = await readBody(request);
    requests.push({
      authorization: request.headers.authorization ?? null,
      body,
      consistencyLevel: headerValue(request.headers["consistencylevel"]),
      method: request.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
    });
    if (url.pathname === `/${tenantId}/oauth2/v2.0/token`) {
      const form = new URLSearchParams(body);
      if (form.get("client_secret") !== clientSecret || form.get("grant_type") !== "client_credentials") {
        return json(response, 401, JSON.stringify({error: "invalid_client"}));
      }
      const token = `stub-graph-token-${tokens.length + 1}`;
      tokens.push(token);
      return json(response, 200, JSON.stringify({access_token: token, expires_in: 3600, token_type: "Bearer"}));
    }
    if (behavior.delayMilliseconds > 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, behavior.delayMilliseconds);
      });
    }
    if (behavior.rejectTokenOnce || request.headers.authorization !== `Bearer ${tokens.at(-1) ?? ""}`) {
      behavior.rejectTokenOnce = false;
      return json(response, 401, JSON.stringify({error: {code: "InvalidAuthenticationToken"}}));
    }
    if (behavior.status !== null) {
      if (behavior.retryAfter !== null) response.setHeader("Retry-After", behavior.retryAfter);
      return json(response, behavior.status, JSON.stringify({error: {code: "stub"}}));
    }
    if (behavior.body !== null) {
      response.writeHead(200, {"Content-Type": "application/json"}).end(behavior.body);
      return undefined;
    }
    return answerGraph(url, response);
  }

  function answerGraph(url: URL, response: ServerResponse): void {
    const membership = /^\/v1\.0\/users\/([^/]+)\/transitiveMemberOf\/microsoft\.graph\.group$/u.exec(url.pathname);
    if (membership !== null) {
      const subject = decodeURIComponent(membership[1] ?? "");
      const ids = groups.filter((group) => group.members.includes(subject)).map(({id}) => ({id}));
      const skip = Number(url.searchParams.get("$skip") ?? "0");
      const page = ids.slice(skip, skip + behavior.pageSize);
      const next = skip + behavior.pageSize < ids.length
        ? `${behavior.nextLinkOrigin ?? origin}${url.pathname}?$skip=${skip + behavior.pageSize}`
        : null;
      return json(response, 200, JSON.stringify(next === null ? {value: page} : {"@odata.nextLink": next, value: page}));
    }
    const single = /^\/v1\.0\/groups\/([^/]+)$/u.exec(url.pathname);
    if (single !== null) {
      const group = groups.find(({id}) => id === decodeURIComponent(single[1] ?? ""));
      return group === undefined
        ? json(response, 404, JSON.stringify({error: {code: "Request_ResourceNotFound"}}))
        : json(response, 200, JSON.stringify(publicGroup(group)));
    }
    if (url.pathname === "/v1.0/groups") {
      const search = /^"displayName:(.*)"$/u.exec(url.searchParams.get("$search") ?? "");
      const filter = /^mail eq '(.*)'$/u.exec(url.searchParams.get("$filter") ?? "");
      const found = groups.filter((group) => {
        if (search !== null) {
          const wanted = (search[1] ?? "").toLowerCase();
          return group.displayName.toLowerCase().split(/\s+/u).some((word) => word.startsWith(wanted));
        }
        if (filter !== null) {
          return group.mail?.toLowerCase() === (filter[1] ?? "").replaceAll("''", "'").toLowerCase();
        }
        return false;
      });
      return json(response, 200, JSON.stringify({value: found.map(publicGroup)}));
    }
    return json(response, 404, JSON.stringify({error: {code: "stub_unknown_path"}}));
  }

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${assignedAddressSchema.parse(server.address()).port}`;
  return {
    behavior,
    clientSecret,
    groups,
    origin,
    requests,
    stop: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    }),
    tenantId,
    tokens,
  };
}

function publicGroup(group: StubGraphGroup) {
  return {displayName: group.displayName, id: group.id, mail: group.mail, visibility: group.visibility};
}

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/** Answer with an already serialized JSON body. */
function json(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {"Content-Type": "application/json"}).end(body);
}

async function readBody(request: IncomingMessage): Promise<string> {
  request.setEncoding("utf8");
  let body = "";
  for await (const chunk of request) body += String(chunk);
  return body;
}
