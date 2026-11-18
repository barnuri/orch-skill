import type { MenuRow } from "../../shared/slash-commands";

interface SlashMenuProps {
  id: string;
  rows: MenuRow[];
  active: number;
  onPick: (index: number) => void;
}

/** The slash menu above the composer. Keys are handled by the composer, which keeps focus in the textarea. */
export function SlashMenu({ id, rows, active, onPick }: SlashMenuProps) {
  return (
    <ul id={id} className="slash-menu" role="listbox" aria-label="Commands and skills">
      {rows.map((row, i) => (
        <li
          key={`${row.kind}:${row.name}`}
          id={`${id}-${i}`}
          role="option"
          aria-selected={i === active}
          className={`slash-row${i === active ? " is-active" : ""}`}
          data-kind={row.kind}
          // mousedown keeps the caret in the textarea; the pick happens on click.
          onMouseDown={(e) => {
            e.preventDefault();
          }}
          onClick={() => {
            onPick(i);
          }}
        >
          <span className="slash-usage mono">{row.usage}</span>
          <span className="slash-desc">{row.description}</span>
        </li>
      ))}
    </ul>
  );
}
