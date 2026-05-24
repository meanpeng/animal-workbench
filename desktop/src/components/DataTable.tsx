import type { ReactNode } from "react";

export interface Column<T> {
  key: string;
  title: string;
  align?: "left" | "center" | "right";
  className?: string;
  render: (row: T, index: number) => ReactNode;
}

export function DataTable<T>({
  columns,
  data,
  rowKey,
  emptyText = "暂无数据",
  loading = false,
}: {
  columns: Column<T>[];
  data: T[];
  rowKey: (row: T, index: number) => string | number;
  emptyText?: string;
  loading?: boolean;
}) {
  if (loading) {
    return <p className="empty-line">加载中...</p>;
  }
  if (data.length === 0) {
    return <p className="empty-line">{emptyText}</p>;
  }

  return (
    <div className="media-table-wrapper">
      <table className="media-table">
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                style={{ textAlign: col.align ?? "left" }}
                className={col.className}
              >
                {col.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, i) => (
            <tr key={rowKey(row, i)}>
              {columns.map((col) => (
                <td
                  key={col.key}
                  style={{ textAlign: col.align ?? "left" }}
                  className={col.className}
                >
                  {col.render(row, i)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
