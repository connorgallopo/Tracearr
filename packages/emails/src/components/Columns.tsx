import type { CSSProperties, ReactNode } from 'react';
import { colors } from '../styles.js';

interface ColumnsProps {
  left: ReactNode;
  right: ReactNode;
  leftStyle?: CSSProperties;
  rightStyle?: CSSProperties;
  tableStyle?: CSSProperties;
}

/** A two-cell presentation table; each cell always carries its own background and text color, so a client inverting per element keeps the text legible. */
export function Columns({ left, right, leftStyle, rightStyle, tableStyle }: ColumnsProps) {
  return (
    <table
      role="presentation"
      width="100%"
      border={0}
      cellPadding={0}
      cellSpacing={0}
      style={tableStyle}
    >
      <tbody>
        <tr>
          <td
            style={{
              backgroundColor: colors.card,
              color: colors.text,
              verticalAlign: 'top',
              ...leftStyle,
            }}
          >
            {left}
          </td>
          <td
            style={{
              backgroundColor: colors.card,
              color: colors.text,
              verticalAlign: 'top',
              ...rightStyle,
            }}
          >
            {right}
          </td>
        </tr>
      </tbody>
    </table>
  );
}
