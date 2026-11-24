# What a TeamClaws workspace can do

Read this reference when helping a user decide what to put on a workspace, or
when carrying out the work they selected. Use their vocabulary and known
projects to turn these capabilities into specific ideas. Describe the outcome
first, then explain the setup it needs. Be descriptive when the user wants to
explore; keep an ordinary post-pairing message focused on a few relevant ideas.

## A server for the user's work

A TeamClaws workspace provides a VPS: a virtual private server with its own
server environment, storage, installed tools, and running processes. Within the
account's permissions and the machine's resources, it can hold complete projects
and execute their workloads. The official CLI can launch commands through the
workspace shell, place authorized files on the machine, inspect results, and help
set up applications and services. A linked AI provider is not required for shell
work. Shell and saved-project lifecycle commands can use account login without a
saved device pairing; the CLI checks account access and binds each request to
this computer. Existing project permissions and request receipts apply.
There is no dedicated `teamclaws deploy` or file-transfer command; use the
paired shell and the project skill's supported transfer and hosting procedures.

Think of it as a workshop the user and their agents can reach from different
places. A user who prefers concrete examples may find "a computer that can keep
working while you're away" clearer than "VPS". Explain the difference between
having a server and having already configured a particular job to keep running.
Inspect the selected host before promising root access, an installed tool,
unlimited resources, GPU capacity, persistent execution, or a public endpoint.

## Host complete jobs from inputs to results

Put the entire workload on the server: code, runtime, dependencies, authorized
input files, configuration, execution, logs, and output files. The agent can
launch it from the CLI, check progress, investigate failures, and bring back
the results. Examples include:

- Processing a folder of images, documents, or recordings and producing a new
  set of files ready for review.
- Importing data, cleaning it, running an analysis, and writing reports or
  exports for the user's existing tools.
- Running a project's test suite, building a release, or executing a lengthy
  conversion without tying up the user's laptop.
- Operating a queue worker that consumes incoming tasks and stores results, or
  scheduling a report or synchronization job to run at the requested times.

For work that should outlive the local command or laptop session, configure a
supported job runner or process manager, retain a job identifier, and verify it
continues independently. Plan storage for inputs, logs, and results. Recurring
jobs need an explicit schedule and stopping conditions; finite jobs need a
completion check. A launched process is not proof of a completed job.

## Keep applications and supporting services running

Host a website, dashboard, API, bot, background worker, webhook receiver, or an
application made of several services. A project may include its own database,
scheduled work, uploaded files, and other persistent data when the host has the
needed resources and permissions. The agent can inspect the project, install
dependencies, configure services, start them, examine logs, and verify health.

For example, a user can keep a small API and its worker beside the project that
uses them, or run a dashboard that is available when they open its browser
address. Configuration, persistence, HTTPS routing, access, and any backup needs
must be addressed as part of the requested setup. Pairing does not configure
these automatically.

## Interact with external servers and services

The workspace can act as a place where systems exchange work. Its programs can
call external APIs, connect to permitted databases, fetch or send authorized
files, and coordinate tasks on other servers through their supported interfaces.
Examples include pulling records from a business system, processing them, and
writing a report; running tests against the user's staging service; or sending
completed results to an existing storage service.

It can also receive webhooks or expose an API after the appropriate incoming
HTTPS route and access controls are configured. Those requests can trigger a
worker, update a dashboard, or start an authorized workflow. External access
depends on network rules, destination permissions, credentials, and service
limits. TeamClaws pairing supplies workspace access; the user must separately
authorize the external operation. Keep secrets in the host's supported secret
mechanism and out of chat, source files, and shell command arguments.

## Run agents beside the project and return through a browser

An agent can work in the workspace with the project's files, tools, and runtime
available there. The user might ask it to investigate a bug, work through a task,
or run an analysis, then return to review the result and continue directing it.
The CLI's `chat start`, `chat send`, and `chat watch` commands support workspace
agent conversations when the workspace advertises the required capabilities.
Follow the chat skill for provider/model discovery and the conversation's
returned identifiers and approval address.

For browser use, rely on the workspace's supported conversation interface or the
installed agent application's verified browser interface. Show the actual
address and explain how the user signs in. A user can then return from another
computer or a phone browser where that interface supports it. Do not promise
that every installed agent exposes a browser UI, or that an arbitrary CLI session
appears in the same browser conversation. Verify that handoff for the selected
agent. An agent running as a service also needs its required provider access,
runtime setup, and process management.

One useful workflow is to start work together at the user's main computer, leave
the configured job or agent running in the workspace, and return through a
browser while away. Suggest this when it fits the user's work; establish that
the workload and interface actually support it before calling it ready.

## Put a complete development or production project on it

The user can ask in ordinary language: "Put this project on my workspace and get
it running." The agent can inspect the existing project, transfer its authorized
files, install dependencies, arrange configuration and persistent data, and set
up the application's services. Ask only for choices or configuration that are
genuinely missing. An existing request to deploy is already authorization to
perform that task within its stated scope.

Choose the intended address and whether access should be public or private
through TeamClaws. Public means the route does not require TeamClaws sign-in;
the application may still have its own login. Private means both TeamClaws
authentication and permission checks must protect it. Verify the supported host
integration before claiming private access works. Preserve the host's existing
admin and chat routes. Production setup depends on the application's operational
needs; a pairing event or successful upload does not establish production
readiness. Follow the project skill and verify health, routing, persistent data,
and the selected access behavior before providing a working URL.

## Share work with other people

Pairing connects this computer to the workspace. It does not add a person as a
workspace user; user membership is a separate privilege.

Distinguish inviting someone to a workspace from sharing a project's web
address. Workspace collaboration depends on the supported TeamClaws sharing
controls and the recipient's assigned access. A public app URL is available
without TeamClaws sign-in; a private project needs the appropriate workspace or
application permissions. Ask who should have access and what they should be able
to do before changing sharing. Do not infer that sharing a link grants workspace
membership, shell access, or permission to use a private project.

## Make the next step feel useful

Use what the user has actually told the agent. For someone building an app,
suggest hosting that app, running its worker, or giving a server agent its next
development task. For someone working with files, suggest an entire processing
job and explain where the results will appear. For someone coordinating a team,
suggest an appropriate shared project or service and establish its access needs.

Use concrete invitations, adapted to the available capabilities and the user's
language, such as:

- "I can run your export job here and save the finished reports for you to pick
  up later. Which job should we move first?"
- "We can put your project and an agent here, then verify the browser link so
  you can come back to the work from your phone. Want to use this project?"
- "I can get this app running at a web address. Should it be public or limited
  to people with TeamClaws access?"

Communicate interest through a useful possibility and a clear next action.
Avoid generic hype, invented familiarity, and an exhaustive pitch after every
command. Continue an already selected task rather than asking the user to choose
again. Respect a decline, status-only question, or explicit request to stop.

## Implementation references

- [Pairing and approval monitoring](../../teamclaws-pair/SKILL.md)
- [CLI workspace agent conversations](../../teamclaws-chat/SKILL.md)
- [Jobs, transfer, services, and hosting](../../teamclaws-project/SKILL.md)

The selected host's current instructions, capability responses, and verified
operation determine what is ready on that host. This reference describes uses
and their prerequisites; it is not evidence that each feature is configured.
