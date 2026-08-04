import {
  CallToolRequest,
  CallToolResult,
  ListResourcesRequest,
  ReadResourceRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { tasks_v1 } from "@googleapis/tasks";

const MAX_TASK_RESULTS = 100;

/**
 * Normalize a due date string to RFC 3339 format expected by Google Tasks API.
 * Google Tasks only stores the date portion, so time is set to midnight UTC.
 * Accepts: "2025-03-19", "2025-03-19T21:00:00", "2025-03-19T21:00:00Z", etc.
 */
export function normalizeDueDate(due: string | undefined): string | undefined {
  if (!due) return undefined;
  const parsed = new Date(due);
  if (isNaN(parsed.getTime())) {
    throw new Error(`Invalid due date format: "${due}". Use YYYY-MM-DD or ISO 8601 format.`);
  }
  // Google Tasks only uses the date portion, so normalize to midnight UTC
  const year = parsed.getUTCFullYear();
  const month = String(parsed.getUTCMonth() + 1).padStart(2, "0");
  const day = String(parsed.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}T00:00:00.000Z`;
}

/**
 * Normalize an arbitrary date/timestamp to full RFC 3339 for the Google Tasks
 * API range filters (dueMin/dueMax, completedMin/completedMax, updatedMin).
 * Unlike normalizeDueDate this preserves the time portion, so callers can pass
 * precise window boundaries (e.g. end-of-day "2026-07-05T23:59:59Z").
 */
export function toRFC3339(value: string, label = "date"): string {
  const parsed = new Date(value);
  if (isNaN(parsed.getTime())) {
    throw new Error(
      `Invalid ${label} value: "${value}". Use YYYY-MM-DD or ISO 8601 format.`,
    );
  }
  return parsed.toISOString();
}

/** A task paired with the list it lives in, so the list name survives merging. */
export interface TaskWithList {
  task: tasks_v1.Schema$Task;
  listId: string;
  listTitle: string;
}

export class TaskResources {
  static async read(request: ReadResourceRequest, tasks: tasks_v1.Tasks) {
    const taskId = request.params.uri.replace("gtasks:///", "");

    const taskListsResponse = await tasks.tasklists.list({
      maxResults: MAX_TASK_RESULTS,
    });

    const taskLists = taskListsResponse.data.items || [];
    let task: tasks_v1.Schema$Task | null = null;

    for (const taskList of taskLists) {
      if (taskList.id) {
        try {
          const taskResponse = await tasks.tasks.get({
            tasklist: taskList.id,
            task: taskId,
          });
          task = taskResponse.data;
          break;
        } catch (error) {
          // Task not found in this list, continue to the next one
        }
      }
    }

    if (!task) {
      throw new Error("Task not found");
    }

    return task;
  }

  static async list(
    request: ListResourcesRequest,
    tasks: tasks_v1.Tasks,
  ): Promise<[tasks_v1.Schema$Task[], string | null]> {
    const pageSize = 10;
    const params: any = {
      maxResults: pageSize,
      showCompleted: true,
      showHidden: true
    };

    if (request.params?.cursor) {
      params.pageToken = request.params.cursor;
    }

    const taskListsResponse = await tasks.tasklists.list({
      maxResults: MAX_TASK_RESULTS,
    });

    const taskLists = taskListsResponse.data.items || [];

    let allTasks: tasks_v1.Schema$Task[] = [];
    let nextPageToken = null;

    for (const taskList of taskLists) {
      const tasksResponse = await tasks.tasks.list({
        tasklist: taskList.id,
        ...params,
      });

      const taskItems = tasksResponse.data.items || [];
      allTasks = allTasks.concat(taskItems);

      if (tasksResponse.data.nextPageToken) {
        nextPageToken = tasksResponse.data.nextPageToken;
      }
    }

    return [allTasks, nextPageToken];
  }
}

export class TaskActions {
  private static formatTask({ task, listTitle }: TaskWithList) {
    return `${task.title}\n (List: ${listTitle} - Due: ${task.due || "Not set"}) - Notes: ${task.notes} - ID: ${task.id} - Status: ${task.status} - URI: ${task.selfLink} - Parent: ${task.parent} - Completed Date: ${task.completed} - Updated Date: ${task.updated}`;
  }

  private static formatTaskList(taskList: TaskWithList[]) {
    return taskList.map((item) => this.formatTask(item)).join("\n");
  }

  /**
   * Fetch tasks with optional server-side filtering. Instead of always pulling
   * every task and filtering client-side, the caller can pass Google Tasks API
   * filters (dueMin/dueMax, completedMin/completedMax, updatedMin, show*) which
   * the API applies before returning — so only matching tasks come over the wire.
   *
   * Note on semantics: within a single call the API ANDs the filters together.
   * "Due this week OR completed this week" is therefore two calls, unioned by id.
   */
  private static async _list(
    request: CallToolRequest,
    tasks: tasks_v1.Tasks,
  ): Promise<TaskWithList[]> {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    // Build the passthrough filter params for tasks.tasks.list.
    const listParams: Record<string, unknown> = {
      maxResults: MAX_TASK_RESULTS,
      showCompleted:
        args.showCompleted === undefined ? true : Boolean(args.showCompleted),
      showHidden: args.showHidden === undefined ? true : Boolean(args.showHidden),
    };
    if (args.showDeleted !== undefined)
      listParams.showDeleted = Boolean(args.showDeleted);
    if (args.dueMin) listParams.dueMin = toRFC3339(args.dueMin as string, "dueMin");
    if (args.dueMax) listParams.dueMax = toRFC3339(args.dueMax as string, "dueMax");
    if (args.completedMin)
      listParams.completedMin = toRFC3339(args.completedMin as string, "completedMin");
    if (args.completedMax)
      listParams.completedMax = toRFC3339(args.completedMax as string, "completedMax");
    if (args.updatedMin)
      listParams.updatedMin = toRFC3339(args.updatedMin as string, "updatedMin");

    // Resolve which lists to query. We always fetch tasklists once so we can
    // attach the list title to each task and honour include/exclude filters.
    const taskListsResponse = await tasks.tasklists.list({
      maxResults: MAX_TASK_RESULTS,
    });
    let taskLists = taskListsResponse.data.items || [];
    if (args.taskListId)
      taskLists = taskLists.filter((l) => l.id === args.taskListId);
    if (args.excludeTaskListId)
      taskLists = taskLists.filter((l) => l.id !== args.excludeTaskListId);

    const allTasks: TaskWithList[] = [];

    for (const taskList of taskLists) {
      if (!taskList.id) continue;
      try {
        let pageToken: string | undefined = undefined;
        do {
          const tasksResponse = await tasks.tasks.list({
            tasklist: taskList.id,
            ...listParams,
            pageToken,
          });
          for (const task of tasksResponse.data.items || []) {
            allTasks.push({
              task,
              listId: taskList.id,
              listTitle: taskList.title || taskList.id,
            });
          }
          pageToken = tasksResponse.data.nextPageToken || undefined;
        } while (pageToken);
      } catch (error) {
        console.error(`Error fetching tasks for list ${taskList.id}:`, error);
      }
    }
    return allTasks;
  }

  static async create(request: CallToolRequest, tasks: tasks_v1.Tasks) {
    const taskListId =
      (request.params.arguments?.taskListId as string) || "@default";
    const taskTitle = request.params.arguments?.title as string;
    const taskNotes = request.params.arguments?.notes as string;
    const taskDue = request.params.arguments?.due as string;

    if (!taskTitle) {
      throw new Error("Task title is required");
    }

    const task: Record<string, string> = {
      title: taskTitle,
    };
    if (taskNotes) task.notes = taskNotes;
    if (taskDue) task.due = normalizeDueDate(taskDue)!;

    const taskResponse = await tasks.tasks.insert({
      tasklist: taskListId,
      requestBody: task,
    });

    return {
      content: [
        {
          type: "text",
          text: `Task created: ${taskResponse.data.title}`,
        },
      ],
      isError: false,
    };
  }

  static async update(request: CallToolRequest, tasks: tasks_v1.Tasks) {
    const taskListId =
      (request.params.arguments?.taskListId as string) || "@default";
    const taskUri = request.params.arguments?.uri as string;
    const taskId = request.params.arguments?.id as string;
    const taskTitle = request.params.arguments?.title as string;
    const taskNotes = request.params.arguments?.notes as string;
    const taskStatus = request.params.arguments?.status as string;
    const taskDue = request.params.arguments?.due as string;

    if (!taskUri) {
      throw new Error("Task URI is required");
    }

    if (!taskId) {
      throw new Error("Task ID is required");
    }

    const task: Record<string, string> = {
      id: taskId,
    };
    if (taskTitle) task.title = taskTitle;
    if (taskNotes) task.notes = taskNotes;
    if (taskStatus) task.status = taskStatus;
    if (taskDue) task.due = normalizeDueDate(taskDue)!;

    const taskResponse = await tasks.tasks.patch({
      tasklist: taskListId,
      task: taskId,
      requestBody: task,
    });

    return {
      content: [
        {
          type: "text",
          text: `Task updated: ${taskResponse.data.title}`,
        },
      ],
      isError: false,
    };
  }

  static async list(request: CallToolRequest, tasks: tasks_v1.Tasks) {
    const allTasks = await this._list(request, tasks);
    const taskList = this.formatTaskList(allTasks);

    return {
      content: [
        {
          type: "text",
          text: `Found ${allTasks.length} tasks:\n${taskList}`,
        },
      ],
      isError: false,
    };
  }

  static async delete(request: CallToolRequest, tasks: tasks_v1.Tasks) {
    const taskListId =
      (request.params.arguments?.taskListId as string) || "@default";
    const taskId = request.params.arguments?.id as string;

    if (!taskId) {
      throw new Error("Task URI is required");
    }

    await tasks.tasks.delete({
      tasklist: taskListId,
      task: taskId,
    });

    return {
      content: [
        {
          type: "text",
          text: `Task ${taskId} deleted`,
        },
      ],
      isError: false,
    };
  }

  static async search(request: CallToolRequest, tasks: tasks_v1.Tasks) {
    const userQuery = request.params.arguments?.query as string;

    const allTasks = await this._list(request, tasks);
    const filteredItems = allTasks.filter(
      ({ task }) =>
        task.title?.toLowerCase().includes(userQuery.toLowerCase()) ||
        task.notes?.toLowerCase().includes(userQuery.toLowerCase()),
    );

    const taskList = this.formatTaskList(filteredItems);

    return {
      content: [
        {
          type: "text",
          text: `Found ${allTasks.length} tasks:\n${taskList}`,
        },
      ],
      isError: false,
    };
  }

  static async clear(request: CallToolRequest, tasks: tasks_v1.Tasks) {
    const taskListId =
      (request.params.arguments?.taskListId as string) || "@default";

    await tasks.tasks.clear({
      tasklist: taskListId,
    });

    return {
      content: [
        {
          type: "text",
          text: `Tasks from tasklist ${taskListId} cleared`,
        },
      ],
      isError: false,
    };
  }
}
