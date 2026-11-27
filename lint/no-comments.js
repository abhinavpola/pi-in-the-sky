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

export default {
  meta: {
    name: "local",
  },
  rules: {
    "no-comments": noComments,
  },
};
