#!/bin/bash
# Template: Form Automation Workflow
# Purpose: Fill and submit web forms with validation
# Usage: ./form-automation.sh <form-url>
#
# This template demonstrates the snapshot-interact-verify pattern:
# 1. Navigate to form
# 2. Snapshot to get element refs
# 3. Fill fields using refs
# 4. Submit and verify result
#
# Customize: Update the refs (@e1, @e2, etc.) based on your form's snapshot output

set -euo pipefail

FORM_URL="${1:?Usage: $0 <form-url>}"

echo "Form automation: $FORM_URL"

# Step 1: Navigate to form
ego-cli open "$FORM_URL"
ego-cli wait --load networkidle

# Step 2: Snapshot to discover form elements
echo ""
echo "Form structure:"
ego-cli snapshot -i

# Step 3: Fill form fields (customize these refs based on snapshot output)
#
# Common field types:
#   ego-cli fill @e1 "John Doe"           # Text input
#   ego-cli fill @e2 "user@example.com"   # Email input
#   ego-cli fill @e3 "SecureP@ss123"      # Password input
#   ego-cli select @e4 "Option Value"     # Dropdown
#   ego-cli check @e5                     # Checkbox
#   ego-cli click @e6                     # Radio button
#   ego-cli fill @e7 "Multi-line text"   # Textarea
#   ego-cli upload @e8 /path/to/file.pdf # File upload
#
# Uncomment and modify:
# ego-cli fill @e1 "Test User"
# ego-cli fill @e2 "test@example.com"
# ego-cli click @e3  # Submit button

# Step 4: Wait for submission
# ego-cli wait --load networkidle
# ego-cli wait --url "**/success"  # Or wait for redirect

# Step 5: Verify result
echo ""
echo "Result:"
ego-cli get url
ego-cli snapshot -i

# Optional: Capture evidence
ego-cli screenshot /tmp/form-result.png
echo "Screenshot saved: /tmp/form-result.png"

# Cleanup
ego-cli close
echo "Done"
