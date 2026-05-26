# Sidebar Project Collapse Design

## Goal

Allow clicking a project row in the chat sidebar to collapse or expand that project's task list.

## Behavior

- Project rows act as disclosure controls.
- Each project can be expanded or collapsed independently.
- Collapsed state persists in `localStorage`, matching existing sidebar preferences such as pinned tasks and project names.
- A project can be collapsed even when it contains the currently selected task.
- Existing project row actions keep their behavior:
  - More actions opens the project menu.
  - New task creates a task in that project.
  - These buttons do not toggle the project.

## UI

- Use the folder icon itself as the disclosure indicator.
- Show an open folder when expanded and a closed folder when collapsed.
- Do not add a separate chevron before the folder icon.
- Keep spacing, hover treatment, selected project styling, and task row styling consistent with the current sidebar.
- Do not show a focus ring or boxed selection outline on project rows.

## Data Flow

- `ChatSidebar` owns a `collapsedProjectKeys` state array.
- The key is the displayed project key used by the current grouping logic.
- Toggling a project updates state and writes `buddy.collapsedProjectKeys` to `localStorage`.
- Rendering hides task rows when the project is collapsed.

## Testing

- Add renderer tests for:
  - Project rows render as disclosure controls.
  - Clicking a project hides and shows its tasks.
  - Clicking the project action buttons does not toggle the project.
  - Selected-task projects can stay collapsed.
