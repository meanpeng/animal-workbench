import sys

path = sys.argv[1]

with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

# ============================================
# Fix 1: import_unlabeled_folder
# ============================================
# Find boundaries
start_marker = '    media_ids = [item["id"] for item in imported]\n    if create_dataset:'
end_marker = '\n\n\ndef import_parsed_labeled_dataset('

start = content.find(start_marker)
end = content.find(end_marker, start)

if start < 0 or end < 0:
    print('ERROR: boundaries not found', start, end)
    sys.exit(1)

print('Unlabeled block: {} to {}'.format(start, end))

# Extract the batch line from the original (contains Chinese chars)
old_block = content[start:end]
batch_line = ''
for line in old_block.split('\n'):
    if 'batch = create_annotation_batch' in line:
        batch_line = line.strip()
        break

print('Batch line:', batch_line[:40])

# Build replacement
new_block = '''    media_ids = [item["id"] for item in imported]
    if create_dataset:
        dataset = create_dataset_record(
            conn,
            project_id,
            dataset_name,
            dataset_type or "user",
            media_ids,
            {
                "source": "folder",
                "source_path": str(root),
                "annotation_status": "unlabeled",
                "format": "unlabeled",
            },
            {
                "media_count": len(imported),
                "annotation_count": 0,
                "class_count": 0,
                "annotation_status": "unlabeled",
            },
        )
        ''' + batch_line.replace('[item["id"] for item in imported]', 'media_ids') + '''
    else:
        dataset = None
        batch = None
    conn.commit()
    return {
        "dataset": dataset,
        "batch": batch,
        "media_ids": media_ids,
        "media_count": len(imported),
        "annotation_count": 0,
        "class_count": 0,
        "format": "unlabeled",
    }'''

content = content[:start] + new_block + content[end:]
print('Fix 1 applied')

# ============================================
# Fix 2: import_parsed_labeled_dataset
# ============================================
# Find the dataset creation block
old_pl_start = '    dataset = create_dataset_record('
idx_pl = content.find(old_pl_start)
if idx_pl < 0:
    print('ERROR: pl start not found')
    sys.exit(1)

# Find the end of the execmany + return block
old_pl_return_end = '    conn.commit()\n    return {\n        "dataset": dataset,\n        "media_count": len(set(media_ids)),'
idx_pl_end = content.find(old_pl_return_end, idx_pl)
if idx_pl_end < 0:
    print('ERROR: pl end not found')
    sys.exit(1)

print('PL block: {} to {}'.format(idx_pl, idx_pl_end))

new_pl = '''if create_dataset:
        dataset = create_dataset_record(
            conn,
            project_id,
            dataset_name,
            dataset_type or ("public" if root.parts[-2:] and "public" in [part.lower() for part in root.parts] else "user"),
            list(dict.fromkeys(media_ids)),
            {
                "source": "folder",
                "source_path": str(root),
                "annotation_status": "labeled",
                "format": parsed.format,
            },
            {
                "media_count": len(set(media_ids)),
                "annotation_count": annotation_count,
                "class_count": len(class_ids),
                "annotation_status": "labeled",
                "format": parsed.format,
            },
        )
        conn.executemany(
            "INSERT OR IGNORE INTO dataset_assets(dataset_id, media_asset_id, split) VALUES(?, ?, ?)",
            [(dataset["id"], media_by_path[sample.image_path]["id"], sample.split) for sample in parsed.samples],
        )
    else:
        dataset = None
    conn.commit()
    return {
        "dataset": dataset,
        "media_ids": list(dict.fromkeys(media_ids)),
        "media_count": len(set(media_ids)),'''

content = content[:idx_pl] + new_pl + content[idx_pl_end + len(old_pl_return_end):]
print('Fix 2 applied')

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)
print('SAVED')
