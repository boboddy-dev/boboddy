function getTypeAnnotation(param) {
  switch (param.type) {
    case "Identifier":
    case "ArrayPattern":
    case "ObjectPattern":
      return param.typeAnnotation?.typeAnnotation ?? null;
    case "AssignmentPattern":
      return getTypeAnnotation(param.left);
    case "RestElement":
      return getTypeAnnotation(param.argument);
    default:
      return null;
  }
}

function containsUnknown(typeNode) {
  if (!typeNode) {
    return false;
  }

  switch (typeNode.type) {
    case "TSUnknownKeyword":
      return true;
    case "TSParenthesizedType":
      return containsUnknown(typeNode.typeAnnotation);
    case "TSUnionType":
    case "TSIntersectionType":
      return typeNode.types.some(containsUnknown);
    default:
      return false;
  }
}

function checkFunctionLike(node, context) {
  for (const param of node.params) {
    const typeAnnotation = getTypeAnnotation(param);

    if (!containsUnknown(typeAnnotation)) {
      continue;
    }

    context.report({
      node: typeAnnotation,
      messageId: "noUnknownParameterType",
    });
  }
}

const noUnknownParameterTypeRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow function and method parameters typed as unknown",
    },
    schema: [],
    messages: {
      noUnknownParameterType:
        "Do not accept `unknown` as a parameter type. Parse at the boundary into a concrete input type, or disable this rule for the rare intentional exception.",
    },
  },
  create(context) {
    return {
      ArrowFunctionExpression(node) {
        checkFunctionLike(node, context);
      },
      FunctionDeclaration(node) {
        checkFunctionLike(node, context);
      },
      FunctionExpression(node) {
        checkFunctionLike(node, context);
      },
      TSDeclareFunction(node) {
        checkFunctionLike(node, context);
      },
      TSFunctionType(node) {
        checkFunctionLike(node, context);
      },
      TSMethodSignature(node) {
        checkFunctionLike(node, context);
      },
    };
  },
};

export const localEslintPlugin = {
  rules: {
    "no-unknown-parameter-type": noUnknownParameterTypeRule,
  },
};
