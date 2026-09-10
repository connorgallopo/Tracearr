import type { CSSProperties, ReactNode } from 'react';
import { colors } from '../styles.js';

interface CellProps {
  /** Applied to the table: width caps and centering live here. */
  tableStyle?: CSSProperties;
  /** Applied to the one cell; background and text color are always set. */
  style?: CSSProperties;
  children: ReactNode;
}

/** A presentation table with one cell that always carries its own background and text color, so a client inverting per element keeps the text legible. */
export function Cell({ tableStyle, style, children }: CellProps) {
  return (
    <table
      role="presentation"
      align="center"
      width="100%"
      border={0}
      cellPadding={0}
      cellSpacing={0}
      style={tableStyle}
    >
      <tbody>
        <tr>
          <td style={{ backgroundColor: colors.page, color: colors.text, ...style }}>{children}</td>
        </tr>
      </tbody>
    </table>
  );
}
