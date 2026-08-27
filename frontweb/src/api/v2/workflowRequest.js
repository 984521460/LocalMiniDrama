import axios from 'axios'

const workflowRequest = axios.create({
  baseURL: '/api/v1',
  timeout: 600000,
  headers: { 'Content-Type': 'application/json' },
})

workflowRequest.interceptors.response.use((response) => {
  const body = response.data
  if (body?.success === true && Object.hasOwn(body, 'data')) return body.data
  const error = new Error('Workflow request failed')
  error.response = response
  return Promise.reject(error)
}, (error) => Promise.reject(error))

export default workflowRequest
