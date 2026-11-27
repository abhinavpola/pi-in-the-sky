const noComments = {
  meta: {
    type: "problem",
    messages: {
      noComment: "Comments are not allowed.",
    },
    schema: [],
  },
  create(context) {
    const { sourceCode } = context;
    return {
      Program() {
        for (const comment of sourceCode.getAllComments()) {
          if (comment.type === "Shebang") {
            continue;
          }
          context.report({
            loc: comment.loc,
            messageId: "noComment",
          });
        }
      },
    };
  },
};

const noReExports = {
  meta: {
    type: "problem",
    messages: {
      noReExport: "Re-exporting from another module is not allowed.",
    },
    schema: [],
  },
  create(context) {
    return {
      ExportAllDeclaration(node) {
        context.report({
          node,
          messageId: "noReExport",
        });
      },
      ExportNamedDeclaration(node) {
        if (node.source) {
          context.report({
            node,
            messageId: "noReExport",
          });
        }
      },
    };
  },
};

const noAliasing = {
  meta: {
    type: "problem",
    messages: {
      noImportAlias: "Import aliasing is not allowed.",
      noExportAlias: "Export aliasing is not allowed.",
    },
    schema: [],
  },
  create(context) {
    return {
      ImportSpecifier(node) {
        const importedName =
          node.imported.type === "Identifier"
            ? node.imported.name
            : node.imported.value;
        if (importedName !== node.local.name) {
          context.report({
            node,
            messageId: "noImportAlias",
          });
        }
      },
      ExportSpecifier(node) {
        const localName =
          node.local.type === "Identifier" ? node.local.name : node.local.value;
        const exportedName =
          node.exported.type === "Identifier"
            ? node.exported.name
            : node.exported.value;
        if (localName !== exportedName) {
          context.report({
            node,
            messageId: "noExportAlias",
          });
        }
      },
    };
  },
};

export default {
  meta: {
    name: "local",
  },
  rules: {
    "no-comments": noComments,
    "no-re-exports": noReExports,
    "no-aliasing": noAliasing,
  },
};
