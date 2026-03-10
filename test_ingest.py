import sys
import json
import os

def main():
    print(f"DEBUG: sys.argv = {sys.argv}", file=sys.stderr)
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No file path provided"}))
        return
    
    file_path = sys.argv[1]
    print(f"DEBUG: file_path = {file_path}", file=sys.stderr)
    
    if not os.path.exists(file_path):
        print(json.dumps({"error": f"File not found: {file_path}"}))
        return
    
    print(json.dumps({"status": "success", "file": file_path}))

if __name__ == "__main__":
    main()
