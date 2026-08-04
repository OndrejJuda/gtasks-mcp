#!/usr/bin/env bun

import { fileURLToPath } from "url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs";
import { tasks as createTasks, auth as googleAuth, tasks_v1 } from "@googleapis/tasks";
import path from "path";
import { TaskActions, TaskResources } from "./Tasks.js";

// Initialized in loadCredentialsAndRunServer() before the transport connects,
// so it is always set by the time any request handler runs.
let tasks: tasks_v1.Tasks;

const server = new Server(
  {
    name: "example-servers/gtasks",
    version: "0.1.0",
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  },
);

server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
  const [allTasks, nextPageToken] = await TaskResources.list(request, tasks);
  return {
    resources: allTasks.map((task) => ({
      uri: `gtasks:///${task.id}`,
      mimeType: "text/plain",
      name: task.title,
    })),
    nextCursor: nextPageToken,
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const task = await TaskResources.read(request, tasks);

  const taskDetails = [
    `Title: ${task.title || "No title"}`,
    `Status: ${task.status || "Unknown"}`,
    `Due: ${task.due || "Not set"}`,
    `Notes: ${task.notes || "No notes"}`,
    `Hidden: ${task.hidden || "Unknown"}`,
    `Parent: ${task.parent || "Unknown"}`,
    `Deleted?: ${task.deleted || "Unknown"}`,
    `Completed Date: ${task.completed || "Unknown"}`,
    `Position: ${task.position || "Unknown"}`,
    `ETag: ${task.etag || "Unknown"}`,
    `Links: ${task.links || "Unknown"}`,
    `Kind: ${task.kind || "Unknown"}`,
    `Status: ${task.status || "Unknown"}`,
    `Created: ${task.updated || "Unknown"}`,
    `Updated: ${task.updated || "Unknown"}`,
  ].join("\n");

  return {
    contents: [
      {
        uri: request.params.uri,
        mimeType: "text/plain",
        text: taskDetails,
      },
    ],
  };
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "search",
        description: "Search for a task in Google Tasks",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "list",
        description:
          "List tasks in Google Tasks with optional server-side filtering. " +
          "Prefer the filters below over pulling everything and filtering afterwards. " +
          "Within one call the filters are combined with AND, so 'due this week OR " +
          "completed this week' is two calls unioned by task ID. Dates are RFC 3339 " +
          "(YYYY-MM-DD or full ISO 8601). Task lists are drained across all pages.",
        inputSchema: {
          type: "object",
          properties: {
            taskListId: {
              type: "string",
              description: "Only query this one task list (default: all lists)",
            },
            excludeTaskListId: {
              type: "string",
              description: "Skip this task list (e.g. to exclude a work list)",
            },
            dueMin: {
              type: "string",
              description: "Lower bound (inclusive) for the task due date, RFC 3339",
            },
            dueMax: {
              type: "string",
              description: "Upper bound for the task due date, RFC 3339",
            },
            completedMin: {
              type: "string",
              description:
                "Lower bound for the completion date, RFC 3339 (implies completed tasks)",
            },
            completedMax: {
              type: "string",
              description: "Upper bound for the completion date, RFC 3339",
            },
            updatedMin: {
              type: "string",
              description: "Only tasks updated at or after this time, RFC 3339",
            },
            showCompleted: {
              type: "boolean",
              description: "Include completed tasks (default true)",
            },
            showHidden: {
              type: "boolean",
              description: "Include hidden tasks (default true)",
            },
            showDeleted: {
              type: "boolean",
              description: "Include deleted tasks (default false)",
            },
          },
        },
      },
      {
        name: "create",
        description: "Create a new task in Google Tasks",
        inputSchema: {
          type: "object",
          properties: {
            taskListId: {
              type: "string",
              description: "Task list ID",
            },
            title: {
              type: "string",
              description: "Task title",
            },
            notes: {
              type: "string",
              description: "Task notes",
            },
            due: {
              type: "string",
              description: "Due date (YYYY-MM-DD or ISO 8601 format, e.g. 2025-03-19)",
            },
          },
          required: ["title"],
        },
      },
      {
        name: "clear",
        description: "Clear completed tasks from a Google Tasks task list",
        inputSchema: {
          type: "object",
          properties: {
            taskListId: {
              type: "string",
              description: "Task list ID",
            },
          },
          required: ["taskListId"],
        },
      },
      {
        name: "delete",
        description: "Delete a task in Google Tasks",
        inputSchema: {
          type: "object",
          properties: {
            taskListId: {
              type: "string",
              description: "Task list ID",
            },
            id: {
              type: "string",
              description: "Task id",
            },
          },
          required: ["id", "taskListId"],
        },
      },
      {
        name: "list-tasklists",
        description: "List all task lists in Google Tasks",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "update",
        description: "Update a task in Google Tasks",
        inputSchema: {
          type: "object",
          properties: {
            taskListId: {
              type: "string",
              description: "Task list ID",
            },
            id: {
              type: "string",
              description: "Task ID",
            },
            uri: {
              type: "string",
              description: "Task URI",
            },
            title: {
              type: "string",
              description: "Task title",
            },
            notes: {
              type: "string",
              description: "Task notes",
            },
            status: {
              type: "string",
              enum: ["needsAction", "completed"],
              description: "Task status (needsAction or completed)",
            },
            due: {
              type: "string",
              description: "Due date (YYYY-MM-DD or ISO 8601 format, e.g. 2025-03-19)",
            },
          },
          required: ["id", "uri"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "search") {
    const taskResult = await TaskActions.search(request, tasks);
    return taskResult;
  }
  if (request.params.name === "list") {
    const taskResult = await TaskActions.list(request, tasks);
    return taskResult;
  }
  if (request.params.name === "list-tasklists") {
    const response = await tasks.tasklists.list();
    const taskLists = response.data.items || [];
    const formatted = taskLists
      .map((list) => `${list.title} (ID: ${list.id})`)
      .join("\n");
    return {
      content: [
        {
          type: "text",
          text:
            taskLists.length > 0
              ? `Found ${taskLists.length} task lists:\n${formatted}`
              : "No task lists found",
        },
      ],
    };
  }
  if (request.params.name === "create") {
    const taskResult = await TaskActions.create(request, tasks);
    return taskResult;
  }
  if (request.params.name === "update") {
    const taskResult = await TaskActions.update(request, tasks);
    return taskResult;
  }
  if (request.params.name === "delete") {
    const taskResult = await TaskActions.delete(request, tasks);
    return taskResult;
  }
  if (request.params.name === "clear") {
    const taskResult = await TaskActions.clear(request, tasks);
    return taskResult;
  }
  throw new Error("Tool not found");
});

const credentialsPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.gtasks-server-credentials.json",
);

async function authenticateAndSaveCredentials() {
  // Heavy dependency: only loaded on the manual `auth` code path, never on
  // normal server startup, so it can't slow down the MCP initialize handshake.
  const { authenticate } = await import("@google-cloud/local-auth");

  console.log("Launching auth flow…");
  const p = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../gcp-oauth.keys.json",
  );

  console.log(p);
  const auth = await authenticate({
    keyfilePath: p,
    scopes: ["https://www.googleapis.com/auth/tasks"],
  });
  fs.writeFileSync(credentialsPath, JSON.stringify(auth.credentials));
  console.log("Credentials saved. You can now run the server.");
}

async function loadCredentialsAndRunServer() {
  if (!fs.existsSync(credentialsPath)) {
    console.error(
      "Credentials not found. Please run with 'auth' argument first.",
    );
    process.exit(1);
  }

  const keysPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../gcp-oauth.keys.json",
  );
  const keys = JSON.parse(fs.readFileSync(keysPath, "utf-8"));
  const { client_id, client_secret } = keys.installed ?? keys.web;

  const credentials = JSON.parse(fs.readFileSync(credentialsPath, "utf-8"));
  const auth = new googleAuth.OAuth2(client_id, client_secret, "http://localhost");
  auth.setCredentials(credentials);

  // Persist refreshed tokens automatically
  auth.on("tokens", (tokens) => {
    const current = JSON.parse(fs.readFileSync(credentialsPath, "utf-8"));
    fs.writeFileSync(credentialsPath, JSON.stringify({ ...current, ...tokens }));
  });

  tasks = createTasks({ version: "v1", auth });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.argv[2] === "auth") {
  authenticateAndSaveCredentials().catch(console.error);
} else {
  loadCredentialsAndRunServer().catch(console.error);
}
