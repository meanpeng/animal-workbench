import type { Dataset } from "../../../types";
import { datasetStats, datasetTypeName } from "../uiUtils";
import { DatasetThumbs } from "./DatasetThumbs";
import { EmptyLine } from "./EmptyLine";

type DatasetPickerProps = {
  datasets: Dataset[];
  onSelectDataset: (datasetId: number) => void;
};

export function DatasetPicker({ datasets, onSelectDataset }: DatasetPickerProps) {
  return (
    <section className="stack">
      <div className="panel flush">
        <h2>选择数据集</h2>
        <p className="helper-text">请选择一个数据集开始标注。数据集在「数据集管理」页面创建。</p>
      </div>
      <div className="dataset-select-grid">
        {datasets.length === 0 ? (
          <EmptyLine text="还没有数据集，请先在「数据集管理」中创建或导入。" />
        ) : (
          datasets.map((ds) => (
            <button key={ds.id} className="dataset-select-card" onClick={() => onSelectDataset(ds.id)}>
              <DatasetThumbs datasetId={ds.id} sampleStats={ds.sample_stats} />
              <div className="dataset-select-info">
                <strong>{ds.name}</strong>
                <span>{datasetTypeName(ds.dataset_type)}</span>
                <span className="dataset-select-meta">{datasetStats(ds)}</span>
              </div>
            </button>
          ))
        )}
      </div>
    </section>
  );
}
