import {z} from "zod";

import {DirectoryUnavailable} from "../core/errors.js";
import {
  maximumGroupSearchResults,
  type DirectoryGroup,
  type GroupDirectory,
} from "../core/group-directory.js";

/** What the Entra group directory is built from. */
export interface EntraGroupDirectoryInput {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Microsoft Graph's origin; tests point it at a stand-in. */
  readonly graphOrigin?: string;
  /** The Entra token endpoint's origin; tests point it at a stand-in. */
  readonly loginOrigin?: string;
  readonly tenantId: string;
  /** Upper bound of one request to Entra or Graph. */
  readonly timeoutMilliseconds?: number;
}

const defaultGraphOrigin = "https://graph.microsoft.com";
const defaultLoginOrigin = "https://login.microsoftonline.com";
const defaultTimeoutMilliseconds = 5_000;
/** Renew the token this long before Entra says it expires. */
const tokenRenewalMarginMilliseconds = 60_000;
/** Upper bound of membership pages read for one person (999 groups each). */
const maximumMembershipPages = 20;
const groupFields = "id,displayName,mail,visibility";
/** Directory object ids are UUIDs; anything else never reaches a URL. */
const objectIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;

const tokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
});
const groupSchema = z.object({
  displayName: z.string(),
  id: z.string().min(1),
  mail: z.string().nullable().optional(),
  visibility: z.string().nullable().optional(),
});
const groupPageSchema = z.object({value: z.array(groupSchema)});
const membershipPageSchema = z.object({
  "@odata.nextLink": z.string().optional(),
  value: z.array(z.object({id: z.string().min(1)})),
});

interface AccessToken {
  readonly expiresAt: number;
  readonly value: string;
}

/**
 * Read groups and memberships from Microsoft Entra through Microsoft Graph
 * with client credentials and the application permission
 * `GroupMember.Read.All` (decision 0034). Read-only. Every failure rejects
 * with `DirectoryUnavailable`, which names the HTTP status at most: never
 * the secret, the token, or a response body.
 */
export function createEntraGroupDirectory(input: EntraGroupDirectoryInput): GroupDirectory {
  const graphOrigin = input.graphOrigin ?? defaultGraphOrigin;
  const loginOrigin = input.loginOrigin ?? defaultLoginOrigin;
  const timeoutMilliseconds = input.timeoutMilliseconds ?? defaultTimeoutMilliseconds;
  let token: AccessToken | null = null;

  const send = async (url: URL, init: RequestInit): Promise<Response> => {
    try {
      return await fetch(url, {...init, signal: AbortSignal.timeout(timeoutMilliseconds)});
    } catch {
      throw unavailable("did not answer");
    }
  };

  const accessToken = async (): Promise<string> => {
    if (token !== null && token.expiresAt > Date.now()) return token.value;
    const response = await send(
      new URL(`/${encodeURIComponent(input.tenantId)}/oauth2/v2.0/token`, loginOrigin),
      {
        body: new URLSearchParams({
          client_id: input.clientId,
          client_secret: input.clientSecret,
          grant_type: "client_credentials",
          scope: "https://graph.microsoft.com/.default",
        }),
        headers: {"Content-Type": "application/x-www-form-urlencoded"},
        method: "POST",
      },
    );
    if (!response.ok) throw unavailable(`refused the sign-in with status ${response.status}`);
    const issued = await parseBody(response, tokenSchema);
    if (issued === null) throw unavailable("answered the sign-in in an unexpected form");
    token = {
      expiresAt: Date.now() + issued.expires_in * 1_000 - tokenRenewalMarginMilliseconds,
      value: issued.access_token,
    };
    return token.value;
  };

  /** One Graph read, retried once with a new token when Graph rejects the old one. */
  const read = async (url: URL): Promise<Response> => {
    const request = async (): Promise<Response> => send(url, {
      headers: {Authorization: `Bearer ${await accessToken()}`, ConsistencyLevel: "eventual"},
    });
    const first = await request();
    if (first.status !== 401) return first;
    token = null;
    return request();
  };

  const readPage = async <Page>(url: URL, schema: z.ZodType<Page>): Promise<Page> => {
    const response = await read(url);
    if (!response.ok) throw unavailable(`answered with status ${response.status}`);
    const page = await parseBody(response, schema);
    if (page === null) throw unavailable("answered in an unexpected form");
    return page;
  };

  return {
    findGroup: async (groupId) => {
      if (!objectIdPattern.test(groupId)) return null;
      const url = new URL(`/v1.0/groups/${groupId}`, graphOrigin);
      url.searchParams.set("$select", groupFields);
      const response = await read(url);
      if (response.status === 404) return null;
      if (!response.ok) throw unavailable(`answered with status ${response.status}`);
      const group = await parseBody(response, groupSchema);
      if (group === null) throw unavailable("answered in an unexpected form");
      return shareable(group);
    },
    groupIdsOfSubject: async (subject) => {
      if (!objectIdPattern.test(subject)) return [];
      const first = new URL(`/v1.0/users/${subject}/transitiveMemberOf/microsoft.graph.group`, graphOrigin);
      first.searchParams.set("$select", "id");
      first.searchParams.set("$top", "999");
      first.searchParams.set("$count", "true");
      const groupIds: string[] = [];
      let next: URL | null = first;
      for (let page = 0; next !== null; page += 1) {
        if (page === maximumMembershipPages) throw unavailable("lists more groups than are read for one person");
        // eslint-disable-next-line no-await-in-loop -- each page names the next one
        const answer: z.infer<typeof membershipPageSchema> = await readPage(next, membershipPageSchema);
        groupIds.push(...answer.value.map(({id}) => id));
        next = nextPage(answer["@odata.nextLink"], graphOrigin);
      }
      return groupIds;
    },
    searchGroups: async (query) => {
      const url = new URL("/v1.0/groups", graphOrigin);
      url.searchParams.set("$select", groupFields);
      url.searchParams.set("$top", String(maximumGroupSearchResults));
      if (query.includes("@")) {
        // OData string literal: the only special character is the quote, doubled.
        url.searchParams.set("$filter", `mail eq '${query.replaceAll("'", "''")}'`);
      } else {
        // The search clause is one quoted token; quotes and backslashes cannot be part of it.
        url.searchParams.set("$search", `"displayName:${query.replaceAll(/["\\]/gu, "")}"`);
        url.searchParams.set("$count", "true");
      }
      const page = await readPage(url, groupPageSchema);
      return page.value
        .map(shareable)
        .filter((group) => group !== null)
        .slice(0, maximumGroupSearchResults);
    },
  };
}

/** The group as people read it, or null when its membership is hidden and cannot be checked. */
function shareable(group: z.infer<typeof groupSchema>): DirectoryGroup | null {
  if (group.visibility === "HiddenMembership") return null;
  return {displayName: group.displayName, id: group.id, mail: group.mail ?? null};
}

/** The next membership page, which must stay on the directory's own origin. */
function nextPage(link: string | undefined, graphOrigin: string): URL | null {
  if (link === undefined) return null;
  if (!URL.canParse(link) || new URL(link).origin !== new URL(graphOrigin).origin) {
    throw unavailable("pointed to another address for the next page");
  }
  return new URL(link);
}

/** The response body in the expected form, or null when it is anything else. */
async function parseBody<Body>(response: Response, schema: z.ZodType<Body>): Promise<Body | null> {
  try {
    const parsed = schema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function unavailable(what: string): DirectoryUnavailable {
  return new DirectoryUnavailable({message: `The directory ${what}.`});
}
