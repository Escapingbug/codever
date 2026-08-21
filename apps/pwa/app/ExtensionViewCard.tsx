import type { SessionExtensionView } from "@codever/protocol";

export type ExtensionViewDecisionState =
  | "pending"
  | "submitting"
  | { actionId: string };

export function ExtensionViewCard(props: {
  extensionName: string;
  view: SessionExtensionView;
  cancelActionId: string;
  state: ExtensionViewDecisionState;
  historical?: boolean;
  time?: string;
  onAction(actionId: string): void;
}) {
  const state = props.state;
  const completedAction =
    typeof state === "object"
      ? props.view.actions.find((action) => action.id === state.actionId)
      : undefined;
  const cancelled =
    typeof state === "object" &&
    state.actionId === props.cancelActionId;

  return (
    <div className="permission-card extension-view-card">
      <div className="permission-title extension-view-title">
        <span>◇</span>
        <div>
          <strong>{props.view.title}</strong>
          <small>{props.extensionName} extension</small>
        </div>
      </div>
      <div className="extension-view-elements">
        {props.view.elements.map((element, index) => {
          if (element.type === "status") {
            return (
              <div
                className={`extension-view-status ${element.tone}`}
                key={`${element.type}-${index}`}
              >
                {element.text}
              </div>
            );
          }
          if (element.type === "text") {
            return <p key={`${element.type}-${index}`}>{element.text}</p>;
          }
          if (element.type === "readonly_textarea") {
            return (
              <label
                className="extension-view-preview"
                key={`${element.type}-${index}`}
              >
                <span>{element.label}</span>
                <textarea
                  aria-label={element.label}
                  readOnly
                  rows={Math.min(12, Math.max(3, element.value.split("\n").length))}
                  value={element.value}
                />
              </label>
            );
          }
          return (
            <div className="extension-view-list" key={`${element.type}-${index}`}>
              {element.label && <strong>{element.label}</strong>}
              <ul>
                {element.items.map((item, itemIndex) => (
                  <li key={itemIndex}>{item}</li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
      {props.historical ? (
        <div className="decision-state historical">
          History only · request not replayed
        </div>
      ) : props.state === "submitting" ? (
        <div className="decision-state submitting">Signing response…</div>
      ) : props.state === "pending" ? (
        <div className="permission-actions extension-view-actions">
          {props.view.actions.map((action) => (
            <button
              className={`extension-action ${action.style ?? "secondary"}`}
              key={action.id}
              onClick={() => props.onAction(action.id)}
              type="button"
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : (
        <div className={`decision-state ${cancelled ? "denied" : "approved"}`}>
          {cancelled ? "×" : "✓"} {completedAction?.label ?? "Response sent"}
        </div>
      )}
      {props.time && <time>{props.time}</time>}
    </div>
  );
}
