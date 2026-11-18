<!-- setup-guide: {"auth_modes":["local_api"],"provider":"github","catalog_reviewed_at":"2026-11-18","entry_url":"https://github.com/settings/tokens","sources":["https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens","https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event"]} -->
# GitHub

Create a personal access token in GitHub settings. Prefer a fine-grained token restricted to the repositories and permissions needed, and paste it into [[field:access_token]]. Never share it in chat. Classic tokens may require the repo scope. Repository creation, issues, pull requests, contents and Actions each require the relevant GitHub permissions; organization policies and SSO may impose additional authorization.

For builds, enable GitHub Actions and configure a workflow with `workflow_dispatch` on the repository's default branch. The dispatch action needs Actions write permission. Dispatch only queues the workflow; use runs.list and runs.get to check its actual outcome. Access to repositories and Actions is not proven by the initial account verification.
