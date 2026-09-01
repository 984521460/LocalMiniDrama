import {
  ElAlert,
  ElButton,
  ElCheckbox,
  ElCheckboxGroup,
  ElCol,
  ElCollapse,
  ElCollapseItem,
  ElDescriptions,
  ElDescriptionsItem,
  ElDialog,
  ElDivider,
  ElDropdown,
  ElDropdownItem,
  ElDropdownMenu,
  ElEmpty,
  ElForm,
  ElFormItem,
  ElIcon,
  ElInput,
  ElInputNumber,
  ElLink,
  ElOption,
  ElOptionGroup,
  ElPagination,
  ElProgress,
  ElRadioButton,
  ElRadioGroup,
  ElRow,
  ElSelect,
  ElSkeleton,
  ElSwitch,
  ElTabPane,
  ElTable,
  ElTableColumn,
  ElTabs,
  ElTag,
  ElTooltip,
  ElUpload,
  vLoading,
} from 'element-plus'

const ELEMENT_PLUS_COMPONENTS = Object.freeze([
  ElAlert,
  ElButton,
  ElCheckbox,
  ElCheckboxGroup,
  ElCol,
  ElCollapse,
  ElCollapseItem,
  ElDescriptions,
  ElDescriptionsItem,
  ElDialog,
  ElDivider,
  ElDropdown,
  ElDropdownItem,
  ElDropdownMenu,
  ElEmpty,
  ElForm,
  ElFormItem,
  ElIcon,
  ElInput,
  ElInputNumber,
  ElLink,
  ElOption,
  ElOptionGroup,
  ElPagination,
  ElProgress,
  ElRadioButton,
  ElRadioGroup,
  ElRow,
  ElSelect,
  ElSkeleton,
  ElSwitch,
  ElTabPane,
  ElTable,
  ElTableColumn,
  ElTabs,
  ElTag,
  ElTooltip,
  ElUpload,
])

export const ELEMENT_PLUS_COMPONENT_NAMES = Object.freeze(
  ELEMENT_PLUS_COMPONENTS.map((component) => component.name),
)

const ELEMENT_PLUS_DIRECTIVES = Object.freeze([
  Object.freeze({ name: 'loading', directive: vLoading }),
])

export const ELEMENT_PLUS_DIRECTIVE_NAMES = Object.freeze(
  ELEMENT_PLUS_DIRECTIVES.map(({ name }) => name),
)

export function installElementPlus(app) {
  for (let index = 0; index < ELEMENT_PLUS_COMPONENTS.length; index += 1) {
    const component = ELEMENT_PLUS_COMPONENTS[index]
    app.component(component.name, component)
  }

  for (let index = 0; index < ELEMENT_PLUS_DIRECTIVES.length; index += 1) {
    const { name, directive } = ELEMENT_PLUS_DIRECTIVES[index]
    app.directive(name, directive)
  }
}
